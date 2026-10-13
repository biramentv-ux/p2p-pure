/**
 * did:key encoding/decoding for Ed25519 public keys.
 *
 * Spec: https://w3c-ccg.github.io/did-method-key/
 * Format: "did:key:" + multibase(base58-btc, multicodec-prefix || raw-pubkey)
 *
 * The Ed25519 public-key multicodec code is 0xed01 (unsigned varint),
 * which for this single-byte-range value is simply the two bytes
 * [0xed, 0x01]. Base58-btc multibase uses the 'z' prefix character,
 * which is why Ed25519 did:keys conventionally start with "did:key:z6Mk".
 */
import { base58 as base58btc } from "@scure/base";
import { IdentityError } from "./types";

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);
const DID_KEY_PREFIX = "did:key:";
/** Multibase indicator byte for base58-btc encoding (not part of @scure/base's output). */
const MULTIBASE_BASE58BTC = "z";

export function publicKeyToDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${publicKey.length} bytes`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return DID_KEY_PREFIX + MULTIBASE_BASE58BTC + base58btc.encode(prefixed);
}

export function didKeyToPublicKey(did: string): Uint8Array {
  if (!did.startsWith(DID_KEY_PREFIX + MULTIBASE_BASE58BTC)) {
    throw new IdentityError(`Not a supported did:key: ${did}`, "INVALID_MNEMONIC");
  }
  const multibaseValue = did.slice((DID_KEY_PREFIX + MULTIBASE_BASE58BTC).length);
  const decoded = base58btc.decode(multibaseValue);
  const prefix = decoded.slice(0, 2);
  if (prefix[0] !== ED25519_MULTICODEC_PREFIX[0] || prefix[1] !== ED25519_MULTICODEC_PREFIX[1]) {
    throw new Error("Unsupported did:key multicodec (only Ed25519 is supported)");
  }
  return decoded.slice(2);
}
