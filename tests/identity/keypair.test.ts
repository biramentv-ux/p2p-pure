import { describe, it, expect } from "vitest";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { deriveIdentityKeyPair, sign, verify } from "../../src/identity/keypair";

describe("keypair", () => {
  it("derives a 32-byte public key and 32-byte secret key", () => {
    const seed = mnemonicToSeed(generateMnemonic12());
    const kp = deriveIdentityKeyPair(seed);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey.length).toBe(32);
  });

  it("is deterministic: same BIP39 seed -> same keypair", () => {
    const seed = mnemonicToSeed(generateMnemonic12());
    const kp1 = deriveIdentityKeyPair(seed);
    const kp2 = deriveIdentityKeyPair(seed);
    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.secretKey).toEqual(kp2.secretKey);
  });

  it("different seeds produce different keypairs", () => {
    const seedA = mnemonicToSeed(generateMnemonic12());
    const seedB = mnemonicToSeed(generateMnemonic12());
    const kpA = deriveIdentityKeyPair(seedA);
    const kpB = deriveIdentityKeyPair(seedB);
    expect(kpA.publicKey).not.toEqual(kpB.publicKey);
  });

  it("full mnemonic -> same keypair round trip (recovery simulation)", () => {
    const phrase = generateMnemonic12();
    const kpDeviceA = deriveIdentityKeyPair(mnemonicToSeed(phrase));
    const kpDeviceB = deriveIdentityKeyPair(mnemonicToSeed(phrase)); // "new device"
    expect(kpDeviceA.publicKey).toEqual(kpDeviceB.publicKey);
  });

  it("signs and verifies a message", () => {
    const kp = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const message = new TextEncoder().encode("hello p2p world");
    const signature = sign(message, kp);
    expect(verify(signature, message, kp.publicKey)).toBe(true);
  });

  it("rejects a signature over a tampered message", () => {
    const kp = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const message = new TextEncoder().encode("hello p2p world");
    const signature = sign(message, kp);
    const tampered = new TextEncoder().encode("hello p2p WORLD");
    expect(verify(signature, tampered, kp.publicKey)).toBe(false);
  });

  it("rejects a signature checked against the wrong public key", () => {
    const kpA = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const kpB = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const message = new TextEncoder().encode("hello p2p world");
    const signature = sign(message, kpA);
    expect(verify(signature, message, kpB.publicKey)).toBe(false);
  });
});
