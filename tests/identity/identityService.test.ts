import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// Mock the webauthn module so these tests exercise identityService's
// orchestration logic without needing a real authenticator. Two scenarios
// are covered via the mock's return values: PRF-supported and PRF-absent.
vi.mock("../../src/identity/webauthn", async () => {
  const actual = await vi.importActual<typeof import("../../src/identity/webauthn")>(
    "../../src/identity/webauthn",
  );
  return {
    ...actual,
    isWebAuthnSupported: vi.fn(() => true),
    createPasskey: vi.fn(async () => ({
      credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
      prfSecret: new Uint8Array(32).fill(7),
    })),
    getPasskey: vi.fn(async () => ({
      credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
      prfSecret: new Uint8Array(32).fill(7),
    })),
  };
});

import {
  createIdentity,
  recoverIdentity,
  unlockIdentity,
  hasExistingIdentity,
  deleteLocalIdentity,
  getStoredDid,
} from "../../src/identity/identityService";
import { isWebAuthnSupported, createPasskey, getPasskey } from "../../src/identity/webauthn";
import { IdentityError } from "../../src/identity/types";

function resetDb() {
  // fresh in-memory IndexedDB for each test
  // @ts-expect-error - assigning a fresh factory instance
  globalThis.indexedDB = new IDBFactory();
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.mocked(isWebAuthnSupported).mockReturnValue(true);
  vi.mocked(createPasskey).mockResolvedValue({
    credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
    prfSecret: new Uint8Array(32).fill(7),
  });
  vi.mocked(getPasskey).mockResolvedValue({
    credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
    prfSecret: new Uint8Array(32).fill(7),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("identityService", () => {
  it("has no identity before creation", async () => {
    expect(await hasExistingIdentity()).toBe(false);
  });

  it("creates a new identity with a 12-word mnemonic and a did:key", async () => {
    const result = await createIdentity();
    expect(result.mnemonic.split(" ")).toHaveLength(12);
    expect(result.identity.did.startsWith("did:key:z6Mk")).toBe(true);
    expect(result.usedPrf).toBe(true);
  });

  it("persists the identity so hasExistingIdentity becomes true", async () => {
    await createIdentity();
    expect(await hasExistingIdentity()).toBe(true);
  });

  it("refuses to create a second identity on the same device", async () => {
    await createIdentity();
    await expect(createIdentity()).rejects.toThrow(IdentityError);
    await expect(createIdentity()).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("unlocks the identity via the passkey (PRF) and recovers the same did:key", async () => {
    const created = await createIdentity();
    const unlocked = await unlockIdentity();
    expect(unlocked.did).toBe(created.identity.did);
    expect(unlocked.keyPair.publicKey).toEqual(created.identity.keyPair.publicKey);
  });

  it("fails to unlock when no identity exists yet", async () => {
    await expect(unlockIdentity()).rejects.toMatchObject({ code: "NO_IDENTITY" });
  });

  it("recovers the identical did:key from the mnemonic on a simulated new device", async () => {
    const created = await createIdentity();
    const { mnemonic, identity } = created;

    await deleteLocalIdentity(); // simulate wiping this device's local record
    resetDb(); // simulate a brand new device with an empty IndexedDB

    vi.mocked(createPasskey).mockResolvedValueOnce({
      credentialId: new Uint8Array([9, 9, 9, 9]).buffer,
      prfSecret: new Uint8Array(32).fill(42), // different device, different hardware secret
    });

    const recovered = await recoverIdentity(mnemonic);
    expect(recovered.identity.did).toBe(identity.did);
    expect(recovered.identity.keyPair.publicKey).toEqual(identity.keyPair.publicKey);
  });

  it("rejects recovery with an invalid mnemonic", async () => {
    await expect(recoverIdentity("not a valid mnemonic phrase at all")).rejects.toMatchObject({
      code: "INVALID_MNEMONIC",
    });
  });

  it("falls back to password-based encryption when PRF is unsupported", async () => {
    vi.mocked(createPasskey).mockResolvedValueOnce({
      credentialId: new Uint8Array([5, 5, 5, 5]).buffer,
      prfSecret: null, // authenticator doesn't support PRF
    });

    const result = await createIdentity("correct horse battery staple");
    expect(result.usedPrf).toBe(false);
  });

  it("throws PRF_UNSUPPORTED if PRF is missing and no password fallback given", async () => {
    vi.mocked(createPasskey).mockResolvedValueOnce({
      credentialId: new Uint8Array([5, 5, 5, 5]).buffer,
      prfSecret: null,
    });

    await expect(createIdentity()).rejects.toMatchObject({ code: "PRF_UNSUPPORTED" });
  });

  it("unlocks a password-protected identity with the correct password and rejects the wrong one", async () => {
    vi.mocked(createPasskey).mockResolvedValueOnce({
      credentialId: new Uint8Array([5, 5, 5, 5]).buffer,
      prfSecret: null,
    });
    await createIdentity("correct horse battery staple");

    const unlocked = await unlockIdentity("correct horse battery staple");
    expect(unlocked.did.startsWith("did:key:z6Mk")).toBe(true);

    await expect(unlockIdentity("wrong password")).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
    });
  });

  it("getStoredDid returns null before creation and the did after", async () => {
    expect(await getStoredDid()).toBeNull();
    const created = await createIdentity();
    expect(await getStoredDid()).toBe(created.identity.did);
  });

  it("deleteLocalIdentity wipes the local record", async () => {
    await createIdentity();
    await deleteLocalIdentity();
    expect(await hasExistingIdentity()).toBe(false);
  });
});
