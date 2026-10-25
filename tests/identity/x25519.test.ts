import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { identityX25519Public } from "../../src/identity/x25519";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

describe("identityX25519Public", () => {
  it("maps an Ed25519 identity key to the X25519 key the session uses", () => {
    const kp = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const mapped = identityX25519Public(kp.publicKey);
    expect(mapped).toHaveLength(32);
    // The session derives the same key from the secret side: the two must agree.
    const secret = ed25519.utils.toMontgomerySecret(kp.secretKey);
    expect(Array.from(x25519.getPublicKey(secret))).toEqual(Array.from(mapped));
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => identityX25519Public(new Uint8Array(31))).toThrow("32 bytes");
  });
});
