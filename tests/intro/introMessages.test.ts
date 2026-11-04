import { describe, expect, it } from "vitest";
import { base58 } from "@scure/base";
import { decodeControl, decodeIntroControl, encodeControl, CONTROL_MARK } from "../../src/p2p/control";
import {
  cleanIntroName,
  MAX_INTRO_INVITATION_CHARS,
  newIntroId,
  validDidKey,
  validIntroMessage,
} from "../../src/intro/introMessages";
import { person } from "../group/fakeLinks";

const id = newIntroId();
const did = person("Б").did;

function raw(o: unknown): string {
  return CONTROL_MARK + JSON.stringify(o);
}

describe("intro control messages", () => {
  it("round-trips every message type through the control channel", () => {
    const all = [
      { t: "intro-request", id },
      { t: "intro-offer", id, did, name: "Боби", exp: 1_900_000_000_000 },
      { t: "intro-offer", id, did, name: "Боби", exp: 1_900_000_000_000, req: newIntroId() },
      { t: "intro-accept", id },
      { t: "intro-decline", id },
      { t: "intro-ready", id, offer: true },
      { t: "intro-relay", id, inv: "p2p1:abc_DEF-123" },
      { t: "intro-cancel", id },
    ] as const;
    for (const m of all) expect(decodeIntroControl(encodeControl(m))).toEqual(m);
  });

  it("the chat's own decoder ignores introductions (the chat screen never sees them)", () => {
    expect(decodeControl(encodeControl({ t: "intro-accept", id }))).toBeNull();
    expect(decodeControl(encodeControl({ t: "wipe" }))).toEqual({ t: "wipe" });
    expect(decodeIntroControl(encodeControl({ t: "wipe" }))).toBeNull();
  });

  it("new ids are valid and differ", () => {
    const a = newIntroId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newIntroId()).not.toBe(a);
  });

  it("refuses bad ids, unknown keys and wrong types", () => {
    expect(decodeIntroControl(raw({ t: "intro-accept", id: "short" }))).toBeNull();
    expect(decodeIntroControl(raw({ t: "intro-accept", id: "x".repeat(33) }))).toBeNull();
    expect(decodeIntroControl(raw({ t: "intro-accept", id: "bad id with spaces!!" }))).toBeNull();
    expect(decodeIntroControl(raw({ t: "intro-accept", id, extra: 1 }))).toBeNull();
    expect(decodeIntroControl(raw({ t: "intro-ready", id, offer: "yes" }))).toBeNull();
    expect(decodeIntroControl(raw({ t: "intro-nope", id }))).toBeNull();
    expect(decodeIntroControl(raw([{ t: "intro-accept", id }]))).toBeNull();
    expect(validIntroMessage(null)).toBeNull();
  });

  it("an offer needs a real Ed25519 did:key, a clean name and an integer expiry", () => {
    const ok = { t: "intro-offer", id, did, name: "Боби", exp: 1_900_000_000_000 };
    expect(validIntroMessage(ok)).not.toBeNull();
    expect(validIntroMessage({ ...ok, did: "did:web:example.com" })).toBeNull();
    // An X25519 did:key (multicodec 0xec01) is not an Ed25519 identity.
    const x25519Did = "did:key:" + "z" + base58.encode(new Uint8Array([0xec, 0x01, ...new Uint8Array(32).fill(9)]));
    expect(validIntroMessage({ ...ok, did: x25519Did })).toBeNull();
    expect(validIntroMessage({ ...ok, did: "did:key:z6Mk" })).toBeNull();
    expect(validIntroMessage({ ...ok, name: "" })).toBeNull();
    expect(validIntroMessage({ ...ok, name: " Боби" })).toBeNull();
    expect(validIntroMessage({ ...ok, name: "x".repeat(65) })).toBeNull();
    expect(validIntroMessage({ ...ok, name: "Бо‮би" })).toBeNull();
    expect(validIntroMessage({ ...ok, name: "Бо\nби" })).toBeNull();
    expect(validIntroMessage({ ...ok, exp: 1.5 })).toBeNull();
    expect(validIntroMessage({ ...ok, exp: "1" })).toBeNull();
    expect(validIntroMessage({ ...ok, req: "bad" })).toBeNull();
  });

  it("a relayed invitation must be a p2p1 invitation within the size limit", () => {
    expect(validIntroMessage({ t: "intro-relay", id, inv: "hello" })).toBeNull();
    expect(validIntroMessage({ t: "intro-relay", id, inv: "p2p1:has space" })).toBeNull();
    expect(validIntroMessage({ t: "intro-relay", id, inv: "p2p1:" + "a".repeat(MAX_INTRO_INVITATION_CHARS) })).toBeNull();
  });

  it("validDidKey accepts a generated did and rejects junk", () => {
    expect(validDidKey(did)).toBe(true);
    expect(validDidKey(42)).toBe(false);
    expect(validDidKey("did:key:z0OIl")).toBe(false);
  });

  it("cleanIntroName strips control characters and cuts long names", () => {
    expect(cleanIntroName("  Ана\u0007 ", "Контакт")).toBe("Ана");
    expect(cleanIntroName("‮", "Контакт")).toBe("Контакт");
    expect(cleanIntroName("я".repeat(100), "Контакт")).toHaveLength(64);
  });
});
