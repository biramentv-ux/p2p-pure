import { describe, it, expect } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { safetyWords, SAFETY_WORD_COUNT } from "../../src/p2p/safety";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;
const carol = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;

describe("safety code", () => {
  it("produces 6 words from the BIP39 list", () => {
    const words = safetyWords(alice, bob);
    expect(words).toHaveLength(SAFETY_WORD_COUNT);
    for (const w of words) expect(wordlist).toContain(w);
  });

  it("is the same on both sides (order-independent)", () => {
    expect(safetyWords(alice, bob)).toEqual(safetyWords(bob, alice));
  });

  it("is deterministic", () => {
    expect(safetyWords(alice, bob)).toEqual(safetyWords(alice, bob));
  });

  it("differs when a different key is presented (MITM detection)", () => {
    // Mallory presents her own key to Bob while Alice believes it is Bob's.
    expect(safetyWords(alice, bob)).not.toEqual(safetyWords(alice, carol));
  });

  it("differs for different pairs", () => {
    expect(safetyWords(alice, bob)).not.toEqual(safetyWords(bob, carol));
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => safetyWords(new Uint8Array(31), bob)).toThrow();
  });
});
