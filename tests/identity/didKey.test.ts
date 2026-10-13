import { describe, it, expect } from "vitest";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { publicKeyToDidKey, didKeyToPublicKey } from "../../src/identity/didKey";

describe("didKey", () => {
  it("encodes an Ed25519 public key as a did:key with the z6Mk... Ed25519 prefix", () => {
    const kp = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const did = publicKeyToDidKey(kp.publicKey);
    expect(did.startsWith("did:key:z6Mk")).toBe(true);
  });

  it("round-trips: did:key -> public key matches the original", () => {
    const kp = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const did = publicKeyToDidKey(kp.publicKey);
    const recovered = didKeyToPublicKey(did);
    expect(recovered).toEqual(kp.publicKey);
  });

  it("produces different did:keys for different public keys", () => {
    const kpA = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const kpB = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    expect(publicKeyToDidKey(kpA.publicKey)).not.toBe(publicKeyToDidKey(kpB.publicKey));
  });

  it("rejects a public key that isn't 32 bytes", () => {
    expect(() => publicKeyToDidKey(new Uint8Array(16))).toThrow();
  });

  it("rejects a string that isn't a did:key", () => {
    expect(() => didKeyToPublicKey("did:web:example.com")).toThrow();
  });

  it("rejects a did:key with an unsupported multicodec", () => {
    // z-prefixed base58btc of some bytes NOT starting with 0xed 0x01
    const fakeDid = "did:key:z1234567890abcdefg";
    expect(() => didKeyToPublicKey(fakeDid)).toThrow();
  });
});
