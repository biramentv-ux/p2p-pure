/**
 * Deterministic Ed25519 identity keypair derivation.
 *
 * The BIP39 seed is 64 bytes (from PBKDF2-HMAC-SHA512 over the mnemonic).
 * We don't use it directly as an Ed25519 seed; instead we pass it through
 * HKDF-SHA256 with a fixed, versioned info string to derive a clean 32-byte
 * Ed25519 seed. This keeps the derivation domain-separated (so the same
 * BIP39 seed could later derive other distinct keys, e.g. for a separate
 * X25519 DH key, without collision) and avoids assumptions about the raw
 * structure of the BIP39 output.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Ed25519KeyPair } from "./types";

const HKDF_INFO_IDENTITY = new TextEncoder().encode("p2p-messenger/identity/ed25519/v1");
const HKDF_SALT = new TextEncoder().encode("p2p-messenger-bip39-identity-salt");

/**
 * Derives the long-term Ed25519 identity keypair from a BIP39 seed.
 * Deterministic: same seed always yields the same keypair, which is what
 * makes recovery-by-mnemonic possible.
 */
export function deriveIdentityKeyPair(bip39Seed: Uint8Array): Ed25519KeyPair {
  const ed25519Seed = hkdf(sha256, bip39Seed, HKDF_SALT, HKDF_INFO_IDENTITY, 32);
  const publicKey = ed25519.getPublicKey(ed25519Seed);
  return { publicKey, secretKey: ed25519Seed };
}

export function sign(message: Uint8Array, keyPair: Ed25519KeyPair): Uint8Array {
  return ed25519.sign(message, keyPair.secretKey);
}

export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return ed25519.verify(signature, message, publicKey);
}
