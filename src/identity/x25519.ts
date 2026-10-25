/**
 * The X25519 public key that belongs to an Ed25519 identity public key.
 *
 * This is the birational map (Edwards -> Montgomery), public-key only: it needs no secret,
 * so any peer can compute the other side's X25519 key from the did:key material it has.
 * The Double Ratchet's identity DH uses the same mapping, so the safety code is bound to
 * the same keys the session is built on.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

export function identityX25519Public(ed25519PublicKey: Uint8Array): Uint8Array {
  if (ed25519PublicKey.length !== 32) {
    throw new Error("Identity public key must be 32 bytes.");
  }
  return ed25519.utils.toMontgomery(ed25519PublicKey);
}
