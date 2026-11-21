/**
 * П5 (experiment): the mesh router, the same on every phone. Flooding with a hop limit, as
 * Bitchat does it:
 *
 *  - a packet is relayed once: its id is remembered (bounded, until it expires);
 *  - each hop takes one off the TTL; at 1 it is delivered here if it is ours, never relayed;
 *  - not to the neighbour it came from;
 *  - store and forward: packets for someone else are kept (bounded, until they expire) and
 *    handed to every neighbour that appears later. A phone walking from one group to another
 *    carries messages between them;
 *  - a packet for us is delivered and not relayed further (nobody learns it arrived).
 *
 * No timers and no radio here: `now` and `send` come from outside, so the graph simulation in
 * tests/mesh drives it exactly like the radio does.
 */
import { decodePacket, encodePacket, hex, MAX_LIFETIME_S, MAX_TTL, MeshPacketError, nextHop, type MeshKind, type MeshPacket } from "./packet";

export interface MeshRouterOptions {
  now: () => number;
  /** Hex tags this phone answers to right now (meshTagsNow for every contact). */
  myTags: () => ReadonlySet<string>;
  deliver: (packet: MeshPacket) => void;
  send: (neighbour: string, bytes: Uint8Array) => void;
  random?: (n: number) => Uint8Array;
  maxSeen?: number;
  maxStored?: number;
  maxStoredBytes?: number;
}

export interface MeshStats {
  received: number;
  relayed: number;
  delivered: number;
  duplicates: number;
  dropped: number;
  stored: number;
}

export class MeshRouter {
  private readonly neighbours = new Set<string>();
  private readonly seen = new Map<string, number>(); // id → expires (s)
  private readonly store = new Map<string, { bytes: Uint8Array; expires: number }>();
  private storedBytes = 0;
  readonly stats: MeshStats = { received: 0, relayed: 0, delivered: 0, duplicates: 0, dropped: 0, stored: 0 };

  private readonly o: MeshRouterOptions;
  constructor(o: MeshRouterOptions) {
    this.o = o;
  }

  private nowS(): number {
    return Math.floor(this.o.now() / 1000);
  }

  addNeighbour(id: string): void {
    if (this.neighbours.has(id)) return;
    this.neighbours.add(id);
    this.prune();
    for (const { bytes } of this.store.values()) this.o.send(id, bytes);
  }

  removeNeighbour(id: string): void {
    this.neighbours.delete(id);
  }

  /** Sends a new packet of ours to every neighbour. Returns its id (hex). */
  originate(kind: MeshKind, to: Uint8Array, payload: Uint8Array, opts: { ttl?: number; lifetimeS?: number } = {}): string {
    const id = (this.o.random ?? cryptoRandom)(8);
    const bytes = encodePacket({
      kind,
      ttl: Math.min(MAX_TTL, Math.max(1, opts.ttl ?? MAX_TTL)),
      id,
      to,
      expires: this.nowS() + Math.min(MAX_LIFETIME_S, Math.max(60, opts.lifetimeS ?? 3600)),
      payload,
    });
    const key = hex(id);
    this.remember(key, this.nowS() + MAX_LIFETIME_S);
    this.keep(key, bytes);
    for (const n of this.neighbours) this.o.send(n, bytes);
    return key;
  }

  /** A packet from a neighbour. Malformed input is counted and dropped, never thrown. */
  receive(from: string, bytes: Uint8Array): void {
    this.stats.received++;
    let p: MeshPacket;
    try {
      p = decodePacket(bytes);
    } catch (e) {
      if (!(e instanceof MeshPacketError)) throw e;
      this.stats.dropped++;
      return;
    }
    const now = this.nowS();
    if (p.expires <= now || p.expires > now + MAX_LIFETIME_S + 300) {
      this.stats.dropped++;
      return;
    }
    const key = hex(p.id);
    if (this.seen.has(key)) {
      this.stats.duplicates++;
      return;
    }
    this.remember(key, p.expires);
    if (this.o.myTags().has(hex(p.to))) {
      this.stats.delivered++;
      this.o.deliver(p);
      return;
    }
    const onward = nextHop(bytes);
    if (!onward) return;
    this.keep(key, onward);
    for (const n of this.neighbours) {
      if (n === from) continue;
      this.o.send(n, onward);
      this.stats.relayed++;
    }
  }

  private remember(key: string, expires: number): void {
    this.seen.set(key, expires);
    const max = this.o.maxSeen ?? 8192;
    if (this.seen.size > max) {
      this.pruneSeen();
      // Still full: the oldest go first (a Map keeps insertion order).
      for (const k of this.seen.keys()) {
        if (this.seen.size <= max) break;
        this.seen.delete(k);
      }
    }
  }

  private keep(key: string, bytes: Uint8Array): void {
    const p = decodePacket(bytes);
    this.store.set(key, { bytes, expires: p.expires });
    this.storedBytes += bytes.length;
    this.stats.stored = this.store.size;
    const maxN = this.o.maxStored ?? 512;
    const maxB = this.o.maxStoredBytes ?? 1024 * 1024;
    if (this.store.size > maxN || this.storedBytes > maxB) this.prune();
    for (const [k, v] of this.store) {
      if (this.store.size <= maxN && this.storedBytes <= maxB) break;
      this.store.delete(k);
      this.storedBytes -= v.bytes.length;
    }
    this.stats.stored = this.store.size;
  }

  private pruneSeen(): void {
    const now = this.nowS();
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
  }

  private prune(): void {
    const now = this.nowS();
    this.pruneSeen();
    for (const [k, v] of this.store) {
      if (v.expires <= now) {
        this.store.delete(k);
        this.storedBytes -= v.bytes.length;
      }
    }
    this.stats.stored = this.store.size;
  }
}

function cryptoRandom(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
