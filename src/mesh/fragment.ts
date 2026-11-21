/**
 * П5 (experiment): a mesh packet in BLE-sized pieces. A GATT write carries MTU - 3 bytes (about
 * 180 on most phones after negotiation, 20 before), Wi-Fi Aware messages about 255.
 *
 *   0  group id (u16 BE)  per sender, wraps
 *   2  index (u8)
 *   3  count (u8)         1..64
 *   4  data
 */
export const FRAGMENT_HEADER = 4;
export const MAX_FRAGMENTS = 64;

export class FragmentError extends Error {}

let nextGroup = Math.floor(Math.random() * 0xffff);

export function fragment(packet: Uint8Array, mtu: number): Uint8Array[] {
  const room = mtu - FRAGMENT_HEADER;
  if (!Number.isInteger(mtu) || room < 8) throw new FragmentError("mtu");
  const count = Math.max(1, Math.ceil(packet.length / room));
  if (count > MAX_FRAGMENTS) throw new FragmentError("too large for this link");
  const group = (nextGroup = (nextGroup + 1) & 0xffff);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const data = packet.subarray(i * room, (i + 1) * room);
    const f = new Uint8Array(FRAGMENT_HEADER + data.length);
    f[0] = group >> 8;
    f[1] = group & 0xff;
    f[2] = i;
    f[3] = count;
    f.set(data, FRAGMENT_HEADER);
    out.push(f);
  }
  return out;
}

/** Reassembles per neighbour. Bounded: at most 8 groups in flight, each dropped after 10 s. */
export class Reassembler {
  private readonly groups = new Map<number, { parts: (Uint8Array | null)[]; have: number; started: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A whole packet when this piece completes one; null otherwise. Malformed pieces are ignored. */
  push(piece: Uint8Array): Uint8Array | null {
    if (!(piece instanceof Uint8Array) || piece.length <= FRAGMENT_HEADER) return null;
    const group = (piece[0] << 8) | piece[1];
    const index = piece[2];
    const count = piece[3];
    if (count < 1 || count > MAX_FRAGMENTS || index >= count) return null;
    const t = this.now();
    for (const [k, g] of this.groups) if (t - g.started > 10_000) this.groups.delete(k);
    let g = this.groups.get(group);
    if (!g || g.parts.length !== count) {
      g = { parts: new Array<Uint8Array | null>(count).fill(null), have: 0, started: t };
      this.groups.set(group, g);
      if (this.groups.size > 8) this.groups.delete(this.groups.keys().next().value as number);
    }
    if (g.parts[index]) return null;
    g.parts[index] = piece.slice(FRAGMENT_HEADER);
    g.have++;
    if (g.have < count) return null;
    this.groups.delete(group);
    const total = g.parts.reduce((n, p) => n + (p?.length ?? 0), 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of g.parts) {
      out.set(p as Uint8Array, at);
      at += (p as Uint8Array).length;
    }
    return out;
  }
}
