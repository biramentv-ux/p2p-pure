/**
 * П5 (experiment): short texts over LoRa through a Meshtastic radio. The phone talks to its own
 * Meshtastic node over the node's serial/BLE API; the node floods the packet over LoRa (its own
 * hop limit, 3 by default, 7 at most), and the other side's node hands it to that phone.
 *
 * What goes over the air is our mesh packet (packet.ts) with a "box" payload, as the payload of
 * a Meshtastic PRIVATE_APP (256) message on the primary channel. LoRa carries 233 bytes per
 * message, so only short texts fit: fitsLora() says so before anything is sent. Meshtastic's
 * own channel encryption is on top; ours does not rely on it.
 *
 * Only the protobuf fields we need are written by hand (no dependency): ToRadio.packet,
 * MeshPacket.to/decoded/id/hop_limit, Data.portnum/payload, and FromRadio.packet when reading.
 */
export const LORA_MAX_PAYLOAD = 233;
export const PRIVATE_APP = 256;
export const BROADCAST = 0xffffffff;
const START1 = 0x94;
const START2 = 0xc3;
const MAX_FRAME = 512;

export class MeshtasticError extends Error {}

export function fitsLora(meshPacket: Uint8Array): boolean {
  return meshPacket.length <= LORA_MAX_PAYLOAD;
}

/* ---------- protobuf, the few bits we need ---------- */

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function fixed32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function field(no: number, wire: number): number[] {
  return varint((no << 3) | wire);
}

function lenDelimited(no: number, bytes: ArrayLike<number>): number[] {
  return [...field(no, 2), ...varint(bytes.length), ...Array.from(bytes)];
}

/** ToRadio { packet: MeshPacket { to, decoded: Data { portnum: PRIVATE_APP, payload }, id, hop_limit } } */
export function encodeToRadio(payload: Uint8Array, opts: { id: number; hopLimit?: number; to?: number }): Uint8Array {
  if (!fitsLora(payload)) throw new MeshtasticError("too long for LoRa");
  const data = [...field(1, 0), ...varint(PRIVATE_APP), ...lenDelimited(2, payload)];
  const hop = Math.min(7, Math.max(1, opts.hopLimit ?? 3));
  const packet = [...field(2, 5), ...fixed32(opts.to ?? BROADCAST), ...lenDelimited(4, data), ...field(6, 5), ...fixed32(opts.id), ...field(9, 0), ...varint(hop)];
  return Uint8Array.from(lenDelimited(1, packet));
}

/** The serial/TCP stream framing: 0x94 0xC3, length (u16 BE), protobuf. */
export function frame(protobuf: Uint8Array): Uint8Array {
  if (protobuf.length > MAX_FRAME) throw new MeshtasticError("frame");
  const out = new Uint8Array(4 + protobuf.length);
  out[0] = START1;
  out[1] = START2;
  out[2] = protobuf.length >> 8;
  out[3] = protobuf.length & 0xff;
  out.set(protobuf, 4);
  return out;
}

interface Field {
  no: number;
  wire: number;
  value: number | Uint8Array;
}

function readFields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const readVarint = (): number => {
    let r = 0;
    let shift = 0;
    for (;;) {
      if (i >= b.length || shift > 35) throw new MeshtasticError("varint");
      const x = b[i++];
      r += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return r;
      shift += 7;
    }
  };
  while (i < b.length) {
    const key = readVarint();
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, value: readVarint() });
    else if (wire === 2) {
      const len = readVarint();
      if (i + len > b.length) throw new MeshtasticError("length");
      out.push({ no, wire, value: b.slice(i, i + len) });
      i += len;
    } else if (wire === 5) {
      if (i + 4 > b.length) throw new MeshtasticError("fixed32");
      out.push({ no, wire, value: (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0 });
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > b.length) throw new MeshtasticError("fixed64");
      i += 8;
    } else throw new MeshtasticError("wire type");
  }
  return out;
}

/** Our mesh packet from a FromRadio message, or null when it is anything else. */
export function decodeFromRadio(protobuf: Uint8Array): { from: number; payload: Uint8Array } | null {
  try {
    const packet = readFields(protobuf).find((f) => f.no === 2 && f.wire === 2)?.value;
    if (!(packet instanceof Uint8Array)) return null;
    const pf = readFields(packet);
    const from = pf.find((f) => f.no === 1 && f.wire === 5)?.value;
    const decoded = pf.find((f) => f.no === 4 && f.wire === 2)?.value;
    if (!(decoded instanceof Uint8Array)) return null;
    const df = readFields(decoded);
    if (df.find((f) => f.no === 1 && f.wire === 0)?.value !== PRIVATE_APP) return null;
    const payload = df.find((f) => f.no === 2 && f.wire === 2)?.value;
    if (!(payload instanceof Uint8Array) || !fitsLora(payload)) return null;
    return { from: typeof from === "number" ? from : 0, payload };
  } catch (e) {
    if (e instanceof MeshtasticError) return null;
    throw e;
  }
}

/** Splits a serial byte stream into protobuf messages; skips the node's debug text between them. */
export class FrameReader {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf, 0);
    joined.set(chunk, this.buf.length);
    const out: Uint8Array[] = [];
    let i = 0;
    while (i + 4 <= joined.length) {
      if (joined[i] !== START1 || joined[i + 1] !== START2) {
        i++;
        continue;
      }
      const len = (joined[i + 2] << 8) | joined[i + 3];
      if (len > MAX_FRAME) {
        i += 2; // not a real header
        continue;
      }
      if (i + 4 + len > joined.length) break;
      out.push(joined.slice(i + 4, i + 4 + len));
      i += 4 + len;
    }
    this.buf = joined.slice(i).slice(-(MAX_FRAME + 4));
    return out;
  }
}
