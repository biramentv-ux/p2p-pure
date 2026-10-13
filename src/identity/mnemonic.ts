/**
 * BIP39 mnemonic generation, validation, and seed derivation.
 *
 * Uses @scure/bip39 (audited, minimal, no legacy dependency tree).
 * The mnemonic is the user's single recovery secret: whoever holds the
 * 12 words can reconstruct the full identity keypair on any device.
 */
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { IdentityError } from "./types";

/** 128 bits of entropy -> 12-word mnemonic, per spec. */
const ENTROPY_BITS = 128;

export function generateMnemonic12(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Derives a 64-byte BIP39 seed from the mnemonic (+ optional passphrase).
 * This seed is the root of the identity keypair — never store it raw.
 */
export function mnemonicToSeed(phrase: string, passphrase = ""): Uint8Array {
  const normalized = normalizeMnemonic(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new IdentityError("Invalid BIP39 mnemonic phrase.", "INVALID_MNEMONIC");
  }
  return mnemonicToSeedSync(normalized, passphrase);
}
