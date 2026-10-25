/**
 * Safety code: 6 words derived from BOTH identity X25519 public keys.
 *
 * Both sides compute the same words because the two keys are sorted before
 * hashing (order-independent). The words are compared out of band (in person
 * or on a call). A man-in-the-middle would need to present a different key to
 * each side, which produces different words and is caught by the comparison.
 *
 * 6 words x 11 bits = 66 bits from SHA-256. The wordlist is BIP39 English,
 * the only audited list bundled in @scure/bip39.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const SAFETY_DOMAIN = new TextEncoder().encode("p2p-messenger/safety-code/v2");
export const SAFETY_WORD_COUNT = 6;

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

  // Take the first 66 bits as one integer and slice out six 11-bit indices.
  let bits = 0n;
  for (let i = 0; i < 9; i++) bits = (bits << 8n) | BigInt(digest[i]);
  const words: string[] = [];
  for (let i = 0; i < SAFETY_WORD_COUNT; i++) {
    const shift = BigInt(72 - 11 * (i + 1)); // 72 bits read, 66 used
    const index = Number((bits >> shift) & 0x7ffn);
    words.push(wordlist[index]);
  }
  return words;
}

export function formatSafetyCode(words: string[]): string {
  return words.join(" · ");
}
