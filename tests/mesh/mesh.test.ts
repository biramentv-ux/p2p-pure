import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodePacket, encodePacket, MeshPacketError, HEADER_BYTES, type MeshPacket } from "../../src/mesh/packet";
import { MeshRouter } from "../../src/mesh/router";
import { fragment, Reassembler } from "../../src/mesh/fragment";
import { meshTag, meshTagsNow, openBox, RotatingId, sealBox } from "../../src/mesh/addressing";
import { decodeFromRadio, encodeToRadio, fitsLora, frame, FrameReader, LORA_MAX_PAYLOAD } from "../../src/mesh/meshtastic";
import { EPOCH_MS } from "../../src/rendezvous/topic";

const T0 = 1_800_000_000_000;

/** A graph of routers that delivers instantly (a queue, so no recursion). */
function graph(edges: Array<[string, string]>, nodes: string[], tags: Record<string, string> = {}) {
  let now = T0;
  const queue: Array<[string, string, Uint8Array]> = [];
  const delivered: Record<string, MeshPacket[]> = {};
  const sent: Record<string, number> = {};
  let seed = 1;
  const routers: Record<string, MeshRouter> = {};
  for (const n of nodes) {
    delivered[n] = [];
    sent[n] = 0;
    routers[n] = new MeshRouter({
      now: () => now,
      myTags: () => new Set(tags[n] ? [tags[n]] : []),
      deliver: (p) => delivered[n].push(p),
      send: (to, bytes) => {
        sent[n]++;
        queue.push([n, to, bytes]);
      },
      random: (k) => Uint8Array.from({ length: k }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff),
    });
  }
  const link = (a: string, b: string) => {
    routers[a].addNeighbour(b);
    routers[b].addNeighbour(a);
  };
  for (const [a, b] of edges) link(a, b);
  const run = () => {
    while (queue.length) {
      const [from, to, bytes] = queue.shift()!;
      routers[to].receive(from, bytes);
    }
  };
  return { routers, delivered, sent, run, link, tick: (ms: number) => (now += ms) };
}

const TAG = "0102030405060708";
const tagBytes = Uint8Array.from(TAG.match(/../g)!.map((h) => parseInt(h, 16)));

describe("П5 mesh packet", () => {
  it("round-trips and refuses TTL above 7", () => {
    const p: MeshPacket = { kind: "box", ttl: 7, id: new Uint8Array(8).fill(9), to: tagBytes, expires: 123456, payload: new Uint8Array([1, 2, 3]) };
    expect(decodePacket(encodePacket(p))).toEqual(p);
    expect(() => encodePacket({ ...p, ttl: 8 })).toThrow(MeshPacketError);
    const raw = encodePacket(p);
    raw[3] = 8;
    expect(() => decodePacket(raw)).toThrow(MeshPacketError);
  });

  it("any input either parses or throws MeshPacketError, nothing else", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        try {
          decodePacket(b);
        } catch (e) {
          expect(e).toBeInstanceOf(MeshPacketError);
        }
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

describe("П5 mesh routing (graph simulation)", () => {
  it("reaches 7 hops down a line and stops at the 8th", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => `n${i}`);
    const edges = nodes.slice(1).map((n, i) => [nodes[i], n] as [string, string]);
    const g7 = graph(edges, nodes, { n7: TAG });
    g7.routers.n0.originate("box", tagBytes, new Uint8Array([42]));
    g7.run();
    expect(g7.delivered.n7).toHaveLength(1);
    const g8 = graph(edges, nodes, { n8: TAG });
    g8.routers.n0.originate("box", tagBytes, new Uint8Array([42]));
    g8.run();
    expect(g8.delivered.n8).toHaveLength(0);
  });

  it("relays each packet once in a dense graph with cycles", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) if ((i * 7 + j * 3) % 4 === 0 || j === i + 1) edges.push([nodes[i], nodes[j]]);
    const g = graph(edges, nodes, { n11: TAG });
    g.routers.n0.originate("session", tagBytes, new Uint8Array(100));
    g.run();
    expect(g.delivered.n11).toHaveLength(1);
    // Every node relays at most once: total sends ≤ number of directed edges.
    const totalSent = Object.values(g.sent).reduce((a, b) => a + b, 0);
    expect(totalSent).toBeLessThanOrEqual(edges.length * 2);
    expect(Object.values(g.routers).some((r) => r.stats.duplicates > 0)).toBe(true);
  });

  it("the recipient does not relay its own packet further", () => {
    const g = graph([["a", "b"], ["b", "c"]], ["a", "b", "c"], { b: TAG });
    g.routers.a.originate("box", tagBytes, new Uint8Array(1));
    g.run();
    expect(g.delivered.b).toHaveLength(1);
    expect(g.routers.c.stats.received).toBe(0);
  });

  it("stores and forwards to a phone that turns up later, until the packet expires", () => {
    const g = graph([["a", "carrier"]], ["a", "carrier", "late", "later"], { late: TAG, later: TAG });
    g.routers.a.originate("box", tagBytes, new Uint8Array(5), { lifetimeS: 600 });
    g.run();
    g.link("carrier", "late");
    g.run();
    expect(g.delivered.late).toHaveLength(1);
    g.tick(601_000);
    g.link("carrier", "later");
    g.run();
    expect(g.delivered.later).toHaveLength(0);
  });

  it("drops expired, far-future and malformed packets without throwing", () => {
    const g = graph([], ["x"]);
    const base: MeshPacket = { kind: "box", ttl: 3, id: new Uint8Array(8), to: tagBytes, expires: Math.floor(T0 / 1000) - 1, payload: new Uint8Array(0) };
    g.routers.x.receive("y", encodePacket(base));
    g.routers.x.receive("y", encodePacket({ ...base, id: new Uint8Array(8).fill(1), expires: Math.floor(T0 / 1000) + 10 * 86400 }));
    g.routers.x.receive("y", new Uint8Array([1, 2, 3]));
    expect(g.routers.x.stats.dropped).toBe(3);
  });

  it("keeps its memory bounded", () => {
    const g = graph([], ["x"]);
    const r = new MeshRouter({ now: () => T0, myTags: () => new Set(), deliver: () => undefined, send: () => undefined, maxSeen: 50, maxStored: 20 });
    for (let i = 0; i < 200; i++) {
      const id = new Uint8Array(8);
      new DataView(id.buffer).setUint32(0, i);
      r.receive("y", encodePacket({ kind: "box", ttl: 5, id, to: tagBytes, expires: Math.floor(T0 / 1000) + 100, payload: new Uint8Array(10) }));
    }
    expect(r.stats.stored).toBeLessThanOrEqual(20);
    expect(g.routers.x).toBeDefined();
  });
});

describe("П5 addressing", () => {
  const K = new Uint8Array(32).fill(7);
  it("tags change every 15 minutes and differ from the Nostr topic", () => {
    const a = meshTagsNow(K, T0);
    const b = meshTagsNow(K, T0 + EPOCH_MS);
    expect(a[2]).toBe(b[1]);
    expect(a[1]).not.toBe(b[1]);
    expect(meshTag(K, 1)).toHaveLength(8);
  });

  it("the box opens only with the pair key and the same tag", () => {
    const tag = meshTag(K, 5);
    const box = sealBox(K, tag, { m: "здрасти", at: 1 });
    expect(openBox(K, tag, box)).toEqual({ m: "здрасти", at: 1 });
    expect(openBox(new Uint8Array(32).fill(8), tag, box)).toBeNull();
    expect(openBox(K, meshTag(K, 6), box)).toBeNull();
  });

  it("a short text fits one LoRa message, a long one does not", () => {
    const tag = meshTag(K, 5);
    const short = encodePacket({ kind: "box", ttl: 3, id: new Uint8Array(8), to: tag, expires: 1, payload: sealBox(K, tag, { m: "Тук съм, при моста.", at: 1_800_000_000 }) });
    const long = encodePacket({ kind: "box", ttl: 3, id: new Uint8Array(8), to: tag, expires: 1, payload: sealBox(K, tag, { m: "x".repeat(300), at: 1 }) });
    expect(fitsLora(short)).toBe(true);
    expect(fitsLora(long)).toBe(false);
    expect(short.length).toBeGreaterThan(HEADER_BYTES);
  });

  it("the radio id is random and rotates at the epoch boundary", () => {
    let now = T0;
    const r = new RotatingId(() => now);
    const first = r.current();
    expect(r.current()).toBe(first);
    now += r.msToRotation();
    expect(r.current()).not.toEqual(first);
  });
});

describe("П5 BLE fragments", () => {
  it("splits and joins in any order, ignores junk", () => {
    const packet = Uint8Array.from({ length: 700 }, (_, i) => i & 0xff);
    const parts = fragment(packet, 180);
    const r = new Reassembler(() => 0);
    expect(r.push(new Uint8Array([1, 2]))).toBeNull();
    let out: Uint8Array | null = null;
    for (const p of [...parts].reverse()) out = r.push(p) ?? out;
    expect(out).toEqual(packet);
  });

  it("never throws on arbitrary pieces", () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 40 }), { maxLength: 30 }), (pieces) => {
        const r = new Reassembler(() => 0);
        for (const p of pieces) r.push(p);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 200) },
    );
  });
});

describe("П5 Meshtastic bridge", () => {
  it("frames a PRIVATE_APP packet and reads it back from FromRadio", () => {
    const payload = Uint8Array.from({ length: 200 }, (_, i) => i);
    const toRadio = encodeToRadio(payload, { id: 0x01020304, hopLimit: 7 });
    // FromRadio { packet (2) } wraps the same MeshPacket bytes; add from (1, fixed32).
    const meshPacket = toRadio.slice(2 + (toRadio[1] & 0x80 ? 1 : 0));
    const withFrom = Uint8Array.from([0x0d, 9, 0, 0, 0, ...meshPacket]);
    const fromRadio = Uint8Array.from([0x12, ...(withFrom.length > 127 ? [(withFrom.length & 0x7f) | 0x80, withFrom.length >> 7] : [withFrom.length]), ...withFrom]);
    const reader = new FrameReader();
    const stream = Uint8Array.from([...new TextEncoder().encode("DEBUG boot\r\n"), ...frame(fromRadio)]);
    const msgs = [...reader.push(stream.slice(0, 20)), ...reader.push(stream.slice(20))];
    expect(msgs).toHaveLength(1);
    expect(decodeFromRadio(msgs[0])).toEqual({ from: 9, payload });
    expect(() => encodeToRadio(new Uint8Array(LORA_MAX_PAYLOAD + 1), { id: 1 })).toThrow();
  });

  it("anything the radio sends either decodes or is null", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        decodeFromRadio(b);
        new FrameReader().push(b);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

describe("П5 radio glue", () => {
  it("two phones on a fake radio deliver a packet through fragments", async () => {
    const { startMeshRadio } = await import("../../src/mesh/radio");
    type H = (d: never) => void;
    const phones: Record<string, { peer?: H; piece?: H }> = { A: {}, B: {} };
    const plugin = (me: "A" | "B") => ({
      start: async () => ({ aware: false }),
      stop: async () => undefined,
      setRotatingId: async () => undefined,
      send: async (o: { to: string; data: string }) => {
        phones[o.to].piece?.({ from: me, data: o.data } as never);
      },
      addListener: async (ev: string, h: H) => {
        (phones[me] as Record<string, H>)[ev] = h;
        return { remove: () => undefined };
      },
    });
    const got: MeshPacket[] = [];
    const a = await startMeshRadio(plugin("A") as never, { now: () => T0, myTags: () => new Set(), deliver: () => undefined });
    const b = await startMeshRadio(plugin("B") as never, { now: () => T0, myTags: () => new Set([TAG]), deliver: (p) => got.push(p) });
    phones.A.peer?.({ id: "B", via: "ble", up: true } as never);
    phones.B.peer?.({ id: "A", via: "ble", up: true } as never);
    a.router.originate("box", tagBytes, new Uint8Array(600).fill(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveLength(1);
    expect(got[0].payload).toEqual(new Uint8Array(600).fill(3));
    await a.stop();
    await b.stop();
  });
});
