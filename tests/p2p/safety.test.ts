import { describe, it, expect } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { sha256 } from "@noble/hashes/sha2.js";
import { formatSafetyCode, safetyWords, SAFETY_BITS, SAFETY_WORD_COUNT } from "../../src/p2p/safety";
import { identityX25519Public } from "../../src/identity/x25519";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;
const carol = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12())).publicKey;

// The code is computed from the X25519 identity keys, as the session does.
const [aliceX, bobX, carolX] = [alice, bob, carol].map(identityX25519Public);

describe("safety code", () => {
  it("carries at least 128 bits", () => {
    expect(SAFETY_WORD_COUNT).toBe(12);
    expect(SAFETY_BITS).toBeGreaterThanOrEqual(128);
  });

  it("produces 12 words from the BIP39 list", () => {
    const words = safetyWords(aliceX, bobX);
    expect(words).toHaveLength(SAFETY_WORD_COUNT);
    for (const w of words) expect(wordlist).toContain(w);
  });

  it("is the same on both sides (order-independent)", () => {
    expect(safetyWords(aliceX, bobX)).toEqual(safetyWords(bobX, aliceX));
  });

  it("is deterministic", () => {
    expect(safetyWords(aliceX, bobX)).toEqual(safetyWords(aliceX, bobX));
  });

  it("differs when a different key is presented (MITM detection)", () => {
    // Mallory presents her own key to Bob while Alice believes it is Bob's.
    expect(safetyWords(aliceX, bobX)).not.toEqual(safetyWords(aliceX, carolX));
  });

  it("differs for different pairs", () => {
    expect(safetyWords(aliceX, bobX)).not.toEqual(safetyWords(bobX, carolX));
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => safetyWords(new Uint8Array(31), bobX)).toThrow();
  });

  it("matches a fixed vector (v3 domain, sorted keys, 11-bit slices)", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    const domain = new TextEncoder().encode("p2p-messenger/safety-code/v3");
    const digest = sha256(new Uint8Array([...domain, ...a, ...b]));
    let bits = 0n;
    for (let i = 0; i < 17; i++) bits = (bits << 8n) | BigInt(digest[i]);
    const expected = Array.from({ length: 12 }, (_, i) => wordlist[Number((bits >> BigInt(136 - 11 * (i + 1))) & 0x7ffn)]);
    expect(safetyWords(b, a)).toEqual(expected);
  });

  it("formats 3 groups of 4 words", () => {
    const lines = formatSafetyCode(safetyWords(aliceX, bobX)).split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.split(" · ")).toHaveLength(4);
  });
});
