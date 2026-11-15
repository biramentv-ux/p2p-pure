/**
 * Rendezvous keys and topics (Н2, docs/PROTOCOL.md §9).
 *
 * Two contacts compute the same 32-byte key K from their identities alone, with no stored
 * secret: a static X25519 agreement between the Montgomery forms of their Ed25519 keys, then
 * HKDF bound to both did:keys. From K come:
 *  - topic(e) = HMAC-SHA256(K, "topic" || u64be(e)), e = 15-minute epoch. It changes every
 *    15 minutes and says nothing about who the two people are.
 *  - the box key, which seals what is published under the topic (XChaCha20-Poly1305, the
 *    topic as associated data, so a box cannot be moved to another topic or epoch).
 * Nothing here talks to the network.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";

export const EPOCH_MS = 15 * 60 * 1000;
const INFO = new TextEncoder().encode("p2p-messenger/rendezvous/v1");
const BOX_INFO = new TextEncoder().encode("box");
const enc = new TextEncoder();
const dec = new TextDecoder();

export class RendezvousKeyError extends Error {}

/** The pair key. Same result on both sides: the DH is symmetric and the dids are sorted. */
export function pairKey(mySecretKey: Uint8Array, myDid: string, peerPublicKey: Uint8Array, peerDid: string): Uint8Array {
  const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(mySecretKey), ed25519.utils.toMontgomery(peerPublicKey));
  if (shared.every((b) => b === 0)) throw new RendezvousKeyError("low-order key");
  const salt = enc.encode([myDid, peerDid].sort().join("\n"));
  return hkdf(sha256, shared, salt, INFO, 32);
}

export function epochOf(nowMs: number): number {
  return Math.floor(nowMs / EPOCH_MS);
}

/** The topic of one epoch, as 64 lowercase hex characters (the Nostr "t" tag value). */
export function topicFor(key: Uint8Array, epoch: number): string {
  const msg = new Uint8Array(13);
  msg.set(enc.encode("topic"), 0);
  new DataView(msg.buffer).setBigUint64(5, BigInt(epoch), false);
  return bytesToHex(hmac(sha256, key, msg));
}

/** The topics to listen on now: last, current and next epoch (clock skew between devices). */
export function listenTopics(key: Uint8Array, nowMs: number): string[] {
  const e = epochOf(nowMs);
  return [e - 1, e, e + 1].map((x) => topicFor(key, x));
}

function boxKey(key: Uint8Array): Uint8Array {
  return hkdf(sha256, key, undefined, BOX_INFO, 32);
}

/** Seals a JSON value for one topic: b64u(nonce 24 || ciphertext). */
export function sealFor(key: Uint8Array, topic: string, value: unknown, random: (n: number) => Uint8Array = randomBytes): string {
  const nonce = random(24);
  const ct = xchacha20poly1305(boxKey(key), nonce, enc.encode(topic)).encrypt(enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return bytesToBase64Url(out);
}

/** Opens what sealFor made, or null for anything that does not authenticate. */
export function openFor(key: Uint8Array, topic: string, content: string): unknown {
  try {
    const raw = base64UrlToBytes(content);
    if (raw.length < 24 + 16 || raw.length > 64 * 1024) return null;
    const pt = xchacha20poly1305(boxKey(key), raw.subarray(0, 24), enc.encode(topic)).decrypt(raw.subarray(24));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}
