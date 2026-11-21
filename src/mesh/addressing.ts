/**
 * П5 (experiment): who a mesh packet is for, and what the radio says about this phone.
 *
 * Recipient tag: HMAC-SHA256(K, "mesh-tag" || u64be(epoch)), first 8 bytes, K = the Н2 pair key
 * (src/rendezvous/topic.ts). A different label than the Nostr topic, so the tag seen on the mesh
 * cannot be matched with a topic seen on a relay. Changes every 15 minutes; the receiver checks
 * the last, current and next epoch.
 *
 * Rotating radio id: random 6 bytes, new every 15 minutes and on every start. Not derived from
 * the identity, so two sightings of the same phone in different epochs cannot be linked by it.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import { epochOf, openFor, sealFor, EPOCH_MS } from "../rendezvous/topic";
import { hex } from "./packet";

const LABEL = new TextEncoder().encode("mesh-tag");

export function meshTag(pairKey: Uint8Array, epoch: number): Uint8Array {
  const msg = new Uint8Array(LABEL.length + 8);
  msg.set(LABEL, 0);
  new DataView(msg.buffer).setBigUint64(LABEL.length, BigInt(epoch), false);
  return hmac(sha256, pairKey, msg).slice(0, 8);
}

/** The tags this pair answers to now (clock skew between phones: one epoch either way). */
export function meshTagsNow(pairKey: Uint8Array, nowMs: number): string[] {
  const e = epochOf(nowMs);
  return [e - 1, e, e + 1].map((x) => hex(meshTag(pairKey, x)));
}

/**
 * The Н2 box for the mesh: the same XChaCha20-Poly1305 box as on the relays, bound to the tag
 * (as the associated data), carried as bytes instead of base64url.
 */
export function sealBox(pairKey: Uint8Array, tag: Uint8Array, value: unknown): Uint8Array {
  return base64UrlToBytes(sealFor(pairKey, "mesh:" + hex(tag), value));
}

export function openBox(pairKey: Uint8Array, tag: Uint8Array, payload: Uint8Array): unknown {
  return openFor(pairKey, "mesh:" + hex(tag), bytesToBase64Url(payload));
}

export class RotatingId {
  private id = randomBytes(6);
  private epoch: number;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.epoch = epochOf(now());
  }
  /** The id to advertise now; a fresh random one after each 15-minute boundary. */
  current(): Uint8Array {
    const e = epochOf(this.now());
    if (e !== this.epoch) {
      this.epoch = e;
      this.id = randomBytes(6);
    }
    return this.id;
  }
  /** Milliseconds until the next change (so the radio can restart advertising then). */
  msToRotation(): number {
    return EPOCH_MS - (this.now() % EPOCH_MS);
  }
}
