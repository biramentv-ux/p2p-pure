/**
 * Safety code: 12 words derived from BOTH identity X25519 public keys.
 *
 * Both sides compute the same words because the two keys are sorted before
 * hashing (order-independent). The words are compared out of band (in person
 * or on a call). A man-in-the-middle would need to present a different key to
 * each side, which produces different words and is caught by the comparison.
 *
 * v3: 12 words x 11 bits = 132 bits from a domain-separated SHA-256 over
 * (domain || sorted key 1 || sorted key 2). v2 used 6 words (66 bits), which a
 * targeted attacker grinding keys could match with ~2^66 work; 132 bits puts
 * a second-preimage-style grind far out of reach. The domain string changed,
 * so v3 words share nothing with v2 words. The wordlist is BIP39 English, the
 * only audited list bundled in @scure/bip39.
 *
 * Contacts store only a "verified" flag, never the words, so contacts verified
 * with the v2 code stay verified; new comparisons use v3.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const SAFETY_DOMAIN = new TextEncoder().encode("p2p-messenger/safety-code/v3");
export const SAFETY_CODE_VERSION = 3;
export const SAFETY_WORD_COUNT = 12;
export const SAFETY_BITS = SAFETY_WORD_COUNT * 11;
/** Words per displayed group (3 groups of 4 are easier to read aloud). */
export const SAFETY_GROUP_SIZE = 4;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function safetyWords(myX25519Key: Uint8Array, peerX25519Key: Uint8Array): string[] {
  if (myX25519Key.length !== 32 || peerX25519Key.length !== 32) {
    throw new Error("Safety code needs two 32-byte X25519 public keys.");
  }
  const [first, second] =
    compareBytes(myX25519Key, peerX25519Key) <= 0
      ? [myX25519Key, peerX25519Key]
      : [peerX25519Key, myX25519Key];

  const input = new Uint8Array(SAFETY_DOMAIN.length + 64);
  input.set(SAFETY_DOMAIN, 0);
  input.set(first, SAFETY_DOMAIN.length);
  input.set(second, SAFETY_DOMAIN.length + 32);
  const digest = sha256(input);

  // Read the first 17 bytes (136 bits) as one integer; slice out twelve 11-bit indices (132 bits).
  const bytesRead = 17;
  let bits = 0n;
  for (let i = 0; i < bytesRead; i++) bits = (bits << 8n) | BigInt(digest[i]);
  const words: string[] = [];
  for (let i = 0; i < SAFETY_WORD_COUNT; i++) {
    const shift = BigInt(bytesRead * 8 - 11 * (i + 1));
    const index = Number((bits >> shift) & 0x7ffn);
    words.push(wordlist[index]);
  }
  return words;
}

/** Groups of 4 words joined by " · ", groups separated by a newline. */
export function formatSafetyCode(words: string[]): string {
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += SAFETY_GROUP_SIZE) {
    groups.push(words.slice(i, i + SAFETY_GROUP_SIZE).join(" · "));
  }
  return groups.join("\n");
}
