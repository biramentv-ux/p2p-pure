/**
 * П4 (experiment): STUN Binding (RFC 5389) over the native shells' UDP sockets, and telling a
 * cone NAT from a symmetric one. WebRTC does STUN by itself; the native transport has to.
 *
 * NAT kind: ask two STUN servers at different addresses from the same socket. The same public
 * port both times means the mapping does not depend on the destination (cone, punchable
 * directly); a different port means symmetric (birthday punching or a relay).
 */
import type { NatKind } from "./punch";

export const STUN_MAGIC = 0x2112a442;

export function stunBindingRequest(transactionId: Uint8Array): Uint8Array {
  if (transactionId.length !== 12) throw new Error("STUN transaction id must be 12 bytes");
  const b = new Uint8Array(20);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0x0001);
  v.setUint32(4, STUN_MAGIC);
  b.set(transactionId, 8);
  return b;
}

export interface MappedAddress {
  family: "IPv4" | "IPv6";
  address: string;
  port: number;
}

/** XOR-MAPPED-ADDRESS (or the old MAPPED-ADDRESS) from a Binding success for our request; else null. */
export function parseStunResponse(b: Uint8Array, transactionId: Uint8Array): MappedAddress | null {
  if (b.length < 20) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint16(0) !== 0x0101 || v.getUint32(4) !== STUN_MAGIC) return null;
  for (let i = 0; i < 12; i++) if (b[8 + i] !== transactionId[i]) return null;
  const length = v.getUint16(2);
  if (20 + length > b.length) return null;
  let o = 20;
  let plain: MappedAddress | null = null;
  while (o + 4 <= 20 + length) {
    const type = v.getUint16(o);
    const len = v.getUint16(o + 2);
    if (o + 4 + len > b.length) return null;
    if ((type === 0x0020 || type === 0x0001) && len >= 8) {
      const xor = type === 0x0020;
      const family = b[o + 5];
      const n = family === 1 ? 4 : family === 2 ? 16 : 0;
      if (n && len >= 4 + n) {
        const key = new Uint8Array(16);
        new DataView(key.buffer).setUint32(0, STUN_MAGIC);
        key.set(transactionId, 4);
        const port = v.getUint16(o + 6) ^ (xor ? STUN_MAGIC >>> 16 : 0);
        const bytes = Array.from({ length: n }, (_, i) => b[o + 8 + i] ^ (xor ? key[i] : 0));
        const address =
          n === 4 ? bytes.join(".") : Array.from({ length: 8 }, (_, i) => ((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16)).join(":");
        const m: MappedAddress = { family: n === 4 ? "IPv4" : "IPv6", address, port };
        if (xor) return m;
        plain = m;
      }
    }
    o += 4 + Math.ceil(len / 4) * 4;
  }
  return plain;
}

/** Cone when two STUN servers saw the same public address and port; symmetric otherwise. */
export function classifyNat(first: MappedAddress | null, second: MappedAddress | null): NatKind {
  if (!first || !second) return "unknown";
  return first.address === second.address && first.port === second.port ? "cone" : "symmetric";
}
