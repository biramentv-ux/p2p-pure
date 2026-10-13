import { describe, it, expect } from "vitest";
import { generateMnemonic12, isValidMnemonic, mnemonicToSeed, normalizeMnemonic } from "../../src/identity/mnemonic";
import { IdentityError } from "../../src/identity/types";

describe("mnemonic", () => {
  it("generates a 12-word mnemonic", () => {
    const phrase = generateMnemonic12();
    expect(phrase.split(" ")).toHaveLength(12);
  });

  it("generates a valid mnemonic", () => {
    const phrase = generateMnemonic12();
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("generates different mnemonics on each call", () => {
    const a = generateMnemonic12();
    const b = generateMnemonic12();
    expect(a).not.toBe(b);
  });

  it("rejects an invalid mnemonic", () => {
    expect(isValidMnemonic("not a real bip39 phrase at all here now")).toBe(false);
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeMnemonic("  Foo   BAR\nbaz ")).toBe("foo bar baz");
  });

  it("derives a 64-byte seed from a valid mnemonic", () => {
    const phrase = generateMnemonic12();
    const seed = mnemonicToSeed(phrase);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(64);
  });

  it("derives the same seed for the same mnemonic (determinism)", () => {
    const phrase = generateMnemonic12();
    const seed1 = mnemonicToSeed(phrase);
    const seed2 = mnemonicToSeed(phrase);
    expect(seed1).toEqual(seed2);
  });

  it("derives different seeds for different mnemonics", () => {
    const seed1 = mnemonicToSeed(generateMnemonic12());
    const seed2 = mnemonicToSeed(generateMnemonic12());
    expect(seed1).not.toEqual(seed2);
  });

  it("is tolerant of case/whitespace differences when deriving seed", () => {
    const phrase = generateMnemonic12();
    const seedLower = mnemonicToSeed(phrase.toLowerCase());
    const seedMessy = mnemonicToSeed(`  ${phrase.toUpperCase()}  `);
    expect(seedLower).toEqual(seedMessy);
  });

  it("throws IdentityError with INVALID_MNEMONIC code for bad input", () => {
    expect(() => mnemonicToSeed("totally invalid phrase")).toThrow(IdentityError);
    try {
      mnemonicToSeed("totally invalid phrase");
    } catch (e) {
      expect((e as IdentityError).code).toBe("INVALID_MNEMONIC");
    }
  });

  it("different passphrases yield different seeds for the same mnemonic", () => {
    const phrase = generateMnemonic12();
    const seedA = mnemonicToSeed(phrase, "passphraseA");
    const seedB = mnemonicToSeed(phrase, "passphraseB");
    expect(seedA).not.toEqual(seedB);
  });
});
