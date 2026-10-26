import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_SETTINGS,
  STUN_SERVERS,
  buildRtcConfiguration,
  getActiveTurn,
  parseTurnSettings,
  setActiveTurn,
  validateTurnSettings,
  validateTurnUrl,
  type TurnSettings,
} from "../../src/p2p/turnConfig";
import { activateStoredTurn, clearTurnSettings, deactivateTurn, loadTurnSettings, saveTurnSettings } from "../../src/p2p/turnStore";
import { STORE_IDENTITY, withStore } from "../../src/db/database";

const good: TurnSettings = {
  enabled: true,
  url: "turns:turn.example.org:5349",
  username: "alice",
  credential: "s3cret-credential-value",
  relayOnly: false,
};

describe("validateTurnUrl", () => {
  it("accepts turn: and turns: with defaults and normalises case", () => {
    expect(validateTurnUrl("TURN:Relay.Example.org")).toMatchObject({ ok: true, url: "turn:relay.example.org", port: 3478, secure: false });
    expect(validateTurnUrl("turns:relay.example.org")).toMatchObject({ ok: true, port: 5349, secure: true });
    expect(validateTurnUrl("turns:relay.example.org:443?transport=TCP")).toMatchObject({
      ok: true,
      url: "turns:relay.example.org:443?transport=tcp",
    });
    expect(validateTurnUrl("turn:[2001:db8::1]:3478")).toMatchObject({ ok: true });
    expect(validateTurnUrl("turn:203.0.113.5")).toMatchObject({ ok: true });
  });

  it("rejects other schemes, empty input and look-alikes", () => {
    expect(validateTurnUrl("")).toEqual({ ok: false, error: "URL_EMPTY" });
    for (const bad of ["stun:stun.example.org", "https://example.org", "javascript:alert(1)", "example.org", "turnx:example.org", "ws:example.org"]) {
      expect(validateTurnUrl(bad)).toEqual({ ok: false, error: "URL_SCHEME" });
    }
  });

  it("rejects embedded credentials", () => {
    expect(validateTurnUrl("turn:user:pass@relay.example.org")).toEqual({ ok: false, error: "URL_EMBEDDED_CREDENTIALS" });
    expect(validateTurnUrl("turns:user@relay.example.org:5349")).toEqual({ ok: false, error: "URL_EMBEDDED_CREDENTIALS" });
  });

  it("rejects malformed hosts, ports, paths and queries", () => {
    expect(validateTurnUrl("turn://relay.example.org")).toMatchObject({ ok: false });
    expect(validateTurnUrl("turn:relay.example.org/path")).toMatchObject({ ok: false });
    expect(validateTurnUrl("turn:relay.example.org#x")).toMatchObject({ ok: false });
    expect(validateTurnUrl("turn:relay example.org")).toMatchObject({ ok: false });
    expect(validateTurnUrl("turn:relay.example.org:0")).toEqual({ ok: false, error: "URL_PORT" });
    expect(validateTurnUrl("turn:relay.example.org:70000")).toEqual({ ok: false, error: "URL_PORT" });
    expect(validateTurnUrl("turn:relay.example.org:")).toEqual({ ok: false, error: "URL_PORT" });
    expect(validateTurnUrl("turn:relay.example.org:abc")).toEqual({ ok: false, error: "URL_PORT" });
    expect(validateTurnUrl("turn:relay.example.org?transport=sctp")).toEqual({ ok: false, error: "URL_QUERY" });
    expect(validateTurnUrl("turn:999.1.1.1")).toEqual({ ok: false, error: "URL_HOST" });
    expect(validateTurnUrl("turn:-bad-.example.org")).toEqual({ ok: false, error: "URL_HOST" });
    expect(validateTurnUrl("turn:[zzzz]")).toEqual({ ok: false, error: "URL_HOST" });
    expect(validateTurnUrl("turn:" + "a".repeat(300))).toEqual({ ok: false, error: "URL_TOO_LONG" });
  });

  it("warns, but does not reject, for private-range hosts and plain turn:", () => {
    for (const host of ["10.0.0.5", "192.168.1.2", "172.16.0.1", "172.31.255.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "localhost", "nas.local", "router", "[::1]", "[fd00::1]", "[fe80::1]"]) {
      const r = validateTurnUrl(`turns:${host}`);
      expect(r, host).toMatchObject({ ok: true });
      expect(r.ok && r.warnings, host).toContain("PRIVATE_HOST");
    }
    const pub = validateTurnUrl("turns:relay.example.org");
    expect(pub.ok && pub.warnings).toEqual([]);
    expect(validateTurnUrl("turn:172.32.0.1")).toMatchObject({ ok: true, warnings: ["PLAIN_TURN"] });
    const plain = validateTurnUrl("turn:relay.example.org");
    expect(plain.ok && plain.warnings).toEqual(["PLAIN_TURN"]);
  });
});

describe("validateTurnSettings", () => {
  it("accepts a complete config and normalises the URL", () => {
    const r = validateTurnSettings({ ...good, url: "  TURNS:Turn.Example.org:5349 " });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.settings.url).toBe("turns:turn.example.org:5349");
  });

  it("requires username and credential and rejects control characters and huge values", () => {
    expect(validateTurnSettings({ ...good, username: "" })).toEqual({ ok: false, error: "USERNAME_EMPTY", field: "username" });
    expect(validateTurnSettings({ ...good, credential: "" })).toEqual({ ok: false, error: "CREDENTIAL_EMPTY", field: "credential" });
    expect(validateTurnSettings({ ...good, username: "a\nb" })).toMatchObject({ ok: false, error: "FIELD_CONTROL_CHARS" });
    expect(validateTurnSettings({ ...good, credential: "x".repeat(600) })).toMatchObject({ ok: false, error: "FIELD_TOO_LONG" });
    expect(validateTurnSettings({ ...good, url: "stun:x.org" })).toMatchObject({ ok: false, field: "url" });
  });

  it("parseTurnSettings returns null for anything malformed", () => {
    expect(parseTurnSettings(null)).toBeNull();
    expect(parseTurnSettings({ ...good, enabled: "yes" })).toBeNull();
    expect(parseTurnSettings({ ...good, url: "https://x.org" })).toBeNull();
    expect(parseTurnSettings(good)).toEqual(good);
  });
});

describe("buildRtcConfiguration", () => {
  it("is STUN only by default, with no relay policy", () => {
    for (const cfg of [buildRtcConfiguration(null), buildRtcConfiguration(DEFAULT_TURN_SETTINGS), buildRtcConfiguration({ ...good, enabled: false })]) {
      expect(cfg).toEqual({ iceServers: STUN_SERVERS });
      expect(JSON.stringify(cfg)).not.toMatch(/turn/i);
    }
  });

  it("adds the user's TURN server next to STUN when enabled", () => {
    const cfg = buildRtcConfiguration(good);
    expect(cfg.iceServers).toEqual([
      ...STUN_SERVERS,
      { urls: ["turns:turn.example.org:5349"], username: "alice", credential: "s3cret-credential-value" },
    ]);
    expect(cfg.iceTransportPolicy).toBeUndefined();
  });

  it("relay-only drops STUN and forces the relay policy", () => {
    const cfg = buildRtcConfiguration({ ...good, relayOnly: true });
    expect(cfg.iceTransportPolicy).toBe("relay");
    expect(cfg.iceServers).toHaveLength(1);
    expect(JSON.stringify(cfg)).not.toContain("stun:");
  });

  it("never applies relay-only without a usable TURN server", () => {
    expect(buildRtcConfiguration({ ...DEFAULT_TURN_SETTINGS, relayOnly: true })).toEqual({ iceServers: STUN_SERVERS });
    expect(buildRtcConfiguration({ ...good, url: "https://evil.example", relayOnly: true })).toEqual({ iceServers: STUN_SERVERS });
  });

  it("active settings are in memory only and ignored when disabled", () => {
    setActiveTurn(good);
    expect(getActiveTurn()).toEqual(good);
    deactivateTurn();
    expect(getActiveTurn()).toBeNull();
    setActiveTurn({ ...good, enabled: false });
    expect(getActiveTurn()).toBeNull();
  });
});

describe("turnStore (encrypted at rest)", () => {
  const key = new Uint8Array(32).fill(7);
  beforeEach(async () => {
    await clearTurnSettings();
  });

  it("round-trips and leaves no plaintext in IndexedDB", async () => {
    await saveTurnSettings(key, good);
    expect(await loadTurnSettings(key)).toEqual(good);
    const raw = JSON.stringify(await withStore(STORE_IDENTITY, "readonly", (s) => s.get("turnConfigSealed")));
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain("s3cret");
    expect(raw).not.toContain("turn.example.org");
  });

  it("a wrong key yields null (TURN off), not an exception", async () => {
    await saveTurnSettings(key, good);
    expect(await loadTurnSettings(new Uint8Array(32).fill(8))).toBeNull();
  });

  it("activateStoredTurn fills the in-memory config; clear removes both", async () => {
    await saveTurnSettings(key, good);
    await activateStoredTurn(key);
    expect(getActiveTurn()).toEqual(good);
    await clearTurnSettings();
    expect(getActiveTurn()).toBeNull();
    expect(await loadTurnSettings(key)).toBeNull();
  });

  it("is off when nothing was ever saved", async () => {
    expect(await loadTurnSettings(key)).toBeNull();
    expect(await activateStoredTurn(key)).toBeNull();
    expect(getActiveTurn()).toBeNull();
  });
});
