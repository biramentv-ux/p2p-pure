/**
 * П5 (experiment): the mesh packet. Bitchat's model: every phone relays for everyone, a packet
 * lives at most 7 hops, nobody on the way can read it or tell who it is for.
 *
 *   0  'M' (0x4d)           magic
 *   1  version (1)
 *   2  kind                 1 = session (a Double Ratchet message of a live session, as is)
 *                           2 = box (Н2 sealed box for a contact who is not here now)
 *   3  ttl                  hops left, 1..7
 *   4  id (8)               random; relays drop what they have seen
 *  12  to (8)               recipient tag: HMAC of the pair key and the 15-minute epoch, so it
 *                           changes every 15 minutes and only the two people can compute it
 *  20  expires (u32 BE)     unix seconds; relays drop it after this (24 h at most)
 *  24  length (u16 BE)
 *  26  payload
 *
 * No new cryptography: the payload is either the existing session's sealed message or the
 * existing rendezvous box (src/rendezvous/topic.ts). This header is all a relay sees.
 */
export const MESH_MAGIC = 0x4d;
export const MESH_VERSION = 1;
export const MAX_TTL = 7;
export const HEADER_BYTES = 26;
/** Large enough for a text message; files and photos do not go over the mesh. */
export const MAX_PAYLOAD = 8 * 1024;
export const MAX_LIFETIME_S = 24 * 3600;

export type MeshKind = "session" | "box";

export interface MeshPacket {
  kind: MeshKind;
  ttl: number;
  id: Uint8Array;
  to: Uint8Array;
  expires: number;
  payload: Uint8Array;
}

export class MeshPacketError extends Error {}

const KIND_CODE: Record<MeshKind, number> = { session: 1, box: 2 };

export function encodePacket(p: MeshPacket): Uint8Array {
  if (!Number.isInteger(p.ttl) || p.ttl < 1 || p.ttl > MAX_TTL) throw new MeshPacketError("ttl");
  if (p.id.length !== 8 || p.to.length !== 8) throw new MeshPacketError("id");
  if (p.payload.length > MAX_PAYLOAD) throw new MeshPacketError("too large");
  if (!Number.isInteger(p.expires) || p.expires < 0 || p.expires > 0xffffffff) throw new MeshPacketError("expires");
  const out = new Uint8Array(HEADER_BYTES + p.payload.length);
  const v = new DataView(out.buffer);
  out[0] = MESH_MAGIC;
  out[1] = MESH_VERSION;
  out[2] = KIND_CODE[p.kind];
  out[3] = p.ttl;
  out.set(p.id, 4);
  out.set(p.to, 12);
  v.setUint32(20, p.expires, false);
  v.setUint16(24, p.payload.length, false);
  out.set(p.payload, HEADER_BYTES);
  return out;
}

/** Parses a packet; anything malformed throws MeshPacketError and nothing else. */
export function decodePacket(bytes: Uint8Array): MeshPacket {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES) throw new MeshPacketError("short");
  if (bytes[0] !== MESH_MAGIC || bytes[1] !== MESH_VERSION) throw new MeshPacketError("magic");
  const kind = bytes[2] === 1 ? "session" : bytes[2] === 2 ? "box" : null;
  if (!kind) throw new MeshPacketError("kind");
  const ttl = bytes[3];
  if (ttl < 1 || ttl > MAX_TTL) throw new MeshPacketError("ttl");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = v.getUint16(24, false);
  if (length > MAX_PAYLOAD || HEADER_BYTES + length !== bytes.length) throw new MeshPacketError("length");
  return {
    kind,
    ttl,
    id: bytes.slice(4, 12),
    to: bytes.slice(12, 20),
    expires: v.getUint32(20, false),
    payload: bytes.slice(HEADER_BYTES),
  };
}

/** The same packet one hop further: ttl - 1, or null when it must not travel on. */
export function nextHop(bytes: Uint8Array): Uint8Array | null {
  if (bytes[3] <= 1) return null;
  const out = bytes.slice();
  out[3] = bytes[3] - 1;
  return out;
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
