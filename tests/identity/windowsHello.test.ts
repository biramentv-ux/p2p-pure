import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { sha256 } from "@noble/hashes/sha2.js";

// Password identities only (as in WebView2): no passkey is involved here.
vi.mock("../../src/identity/webauthn", async () => {
  const actual = await vi.importActual<typeof import("../../src/identity/webauthn")>("../../src/identity/webauthn");
  return { ...actual, isWebAuthnSupported: vi.fn(() => false) };
});

import {
  createIdentity,
  unlockIdentity,
  getUnlockMethod,
} from "../../src/identity/identityService";
import {
  enableWindowsHello,
  disableWindowsHello,
  unlockWithWindowsHello,
  canEnableWindowsHello,
  windowsHelloCredentialName,
  windowsHelloChallenge,
} from "../../src/identity/windowsHelloUnlock";
import { loadIdentityRecord } from "../../src/identity/storage";
import { IdentityError } from "../../src/identity/types";
import { isWindowsDesktopShell, windowsHelloAvailable } from "../../src/platform/windowsHello";

const PW = "correct horse battery";
const realUA = navigator.userAgent;

/** Fake Tauri shell: deterministic "signature" = SHA-256(device secret || name || challenge) x8. */
function installFakeTauri(opts: { status?: string; deterministic?: boolean; deviceSecret?: number } = {}) {
  let counter = 0;
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "windows_hello_status") return opts.status ?? "available";
    if (cmd === "windows_hello_sign") {
      const name = new TextEncoder().encode(String(args?.name));
      const challenge = Uint8Array.from(args?.challenge as number[]);
      const extra = opts.deterministic === false ? counter++ : 0;
      const block = sha256(new Uint8Array([opts.deviceSecret ?? 1, extra, ...name, ...challenge]));
      const sig = new Uint8Array(256);
      for (let i = 0; i < 8; i++) sig.set(block, i * 32);
      return Array.from(sig);
    }
    throw new Error("unknown command");
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140", configurable: true });
  return { invoke, calls };
}

beforeEach(() => {
  // @ts-expect-error fresh factory per test
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "userAgent", { value: realUA, configurable: true });
  vi.restoreAllMocks();
});

describe("Windows Hello availability", () => {
  it("is hidden outside the Tauri shell (browser, Linux, mobile)", async () => {
    expect(isWindowsDesktopShell()).toBe(false);
    expect(await windowsHelloAvailable()).toBe(false);
    await createIdentity(PW);
    expect(await canEnableWindowsHello()).toBe(false);
    expect(await getUnlockMethod()).toBe("password");
  });

  it("is hidden in Tauri on Windows when Hello is not set up (e.g. CI runner)", async () => {
    installFakeTauri({ status: "unavailable" });
    await createIdentity(PW);
    expect(await canEnableWindowsHello()).toBe(false);
    await expect(enableWindowsHello(PW)).rejects.toMatchObject({ code: "WINDOWS_HELLO_UNAVAILABLE" });
    expect(await getUnlockMethod()).toBe("password");
  });

  it("is hidden when the Tauri shell is not on Windows", async () => {
    installFakeTauri();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64)", configurable: true });
    expect(await windowsHelloAvailable()).toBe(false);
  });
});

// Each case derives the password key (PBKDF2) more than once: seconds on a shared CI runner.
describe("Windows Hello unlock", { timeout: 30_000 }, () => {
  it("enables with the password, then unlocks to the same identity", async () => {
    const { calls } = installFakeTauri();
    const created = await createIdentity(PW);
    expect(await canEnableWindowsHello()).toBe(true);
    await enableWindowsHello(PW);
    expect(await getUnlockMethod()).toBe("windows-hello");

    const unlocked = await unlockWithWindowsHello();
    expect(unlocked.did).toBe(created.identity.did);
    expect(unlocked.keyPair.secretKey).toEqual(created.identity.keyPair.secretKey);

    const signs = calls.filter((c) => c.cmd === "windows_hello_sign");
    expect(signs.map((c) => c.args?.create)).toEqual([true, false, false]);
    expect(signs[0].args?.name).toBe(windowsHelloCredentialName(created.identity.did));
    expect(signs[0].args?.challenge).toHaveLength(32);
  });

  it("keeps the password path working and unchanged", async () => {
    installFakeTauri();
    const created = await createIdentity(PW);
    const before = await loadIdentityRecord();
    await enableWindowsHello(PW);
    const after = await loadIdentityRecord();
    expect(after?.unlockMethod).toBe("password");
    expect(after?.encryptedSeed).toEqual(before?.encryptedSeed);
    expect(after?.kdfSalt).toEqual(before?.kdfSalt);
    expect((await unlockIdentity(PW)).did).toBe(created.identity.did);
    await expect(unlockIdentity("wrong")).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("refuses to enable with a wrong password and stores nothing", async () => {
    const { calls } = installFakeTauri();
    await createIdentity(PW);
    await expect(enableWindowsHello("wrong")).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    expect((await loadIdentityRecord())?.windowsHello).toBeUndefined();
    expect(calls.some((c) => c.cmd === "windows_hello_sign")).toBe(false);
  });

  it("refuses a Hello key whose signatures are not deterministic", async () => {
    installFakeTauri({ deterministic: false });
    await createIdentity(PW);
    await expect(enableWindowsHello(PW)).rejects.toMatchObject({ code: "WINDOWS_HELLO_FAILED" });
    expect((await loadIdentityRecord())?.windowsHello).toBeUndefined();
  });

  it("fails closed when a different Hello key signs (other device/user)", async () => {
    installFakeTauri({ deviceSecret: 1 });
    await createIdentity(PW);
    await enableWindowsHello(PW);
    installFakeTauri({ deviceSecret: 2 });
    await expect(unlockWithWindowsHello()).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("maps a cancelled prompt to WINDOWS_HELLO_FAILED", async () => {
    const { invoke } = installFakeTauri();
    await createIdentity(PW);
    await enableWindowsHello(PW);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "windows_hello_status") return "available";
      throw "cancelled";
    });
    const err = await unlockWithWindowsHello().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityError);
    expect((err as IdentityError).code).toBe("WINDOWS_HELLO_FAILED");
  });

  it("falls back to password when Hello later becomes unavailable", async () => {
    installFakeTauri();
    await createIdentity(PW);
    await enableWindowsHello(PW);
    installFakeTauri({ status: "unavailable" });
    expect(await getUnlockMethod()).toBe("password");
    await expect(unlockWithWindowsHello()).rejects.toMatchObject({ code: "WINDOWS_HELLO_UNAVAILABLE" });
  });

  it("disable removes only the Hello copy", async () => {
    installFakeTauri();
    await createIdentity(PW);
    await enableWindowsHello(PW);
    await disableWindowsHello();
    expect((await loadIdentityRecord())?.windowsHello).toBeUndefined();
    expect(await getUnlockMethod()).toBe("password");
  });

  it("binds the challenge to the did and the salt", () => {
    const salt = new Uint8Array(32).fill(1);
    expect(windowsHelloChallenge("did:key:a", salt)).not.toEqual(windowsHelloChallenge("did:key:b", salt));
    expect(windowsHelloChallenge("did:key:a", salt)).not.toEqual(windowsHelloChallenge("did:key:a", new Uint8Array(32)));
    expect(windowsHelloCredentialName("did:key:a")).toMatch(/^p2p-messenger-[0-9a-f]{32}$/);
  });
});
