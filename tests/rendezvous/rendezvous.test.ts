import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { EPOCH_MS, epochOf, listenTopics, openFor, pairKey, sealFor, topicFor } from "../../src/rendezvous/topic";
import { RENDEZVOUS_KIND, signEvent, verifyEvent, type NostrEvent, type NostrFilter } from "../../src/rendezvous/nostr";
import { RelayPool, type SocketLike } from "../../src/rendezvous/relayPool";
import { OFFER_REPEAT_MS, Rendezvous, type PoolLike } from "../../src/rendezvous/rendezvous";

function person(n: number) {
  const kp = deriveIdentityKeyPair(new Uint8Array(64).fill(n));
  return { kp, did: publicKeyToDidKey(kp.publicKey) };
}
const A = person(1);
const B = person(2);
const C = person(3);

describe("pair key and topics", () => {
  it("both sides compute the same key; a third person gets another", () => {
    const ab = pairKey(A.kp.secretKey, A.did, B.kp.publicKey, B.did);
    const ba = pairKey(B.kp.secretKey, B.did, A.kp.publicKey, A.did);
    expect(ab).toEqual(ba);
    expect(pairKey(C.kp.secretKey, C.did, B.kp.publicKey, B.did)).not.toEqual(ab);
  });

  it("topics rotate every epoch and listening covers the neighbours", () => {
    const k = pairKey(A.kp.secretKey, A.did, B.kp.publicKey, B.did);
    const now = 1_763_200_000_000;
    const e = epochOf(now);
    expect(topicFor(k, e)).toMatch(/^[0-9a-f]{64}$/);
    expect(topicFor(k, e)).not.toBe(topicFor(k, e + 1));
    expect(listenTopics(k, now)).toEqual([topicFor(k, e - 1), topicFor(k, e), topicFor(k, e + 1)]);
    expect(epochOf(now + EPOCH_MS)).toBe(e + 1);
  });

  it("a sealed box opens only with the key and under its own topic", () => {
    const k = pairKey(A.kp.secretKey, A.did, B.kp.publicKey, B.did);
    const other = pairKey(C.kp.secretKey, C.did, B.kp.publicKey, B.did);
    const t = topicFor(k, 5);
    const box = sealFor(k, t, { hello: "свят" });
    expect(openFor(k, t, box)).toEqual({ hello: "свят" });
    expect(openFor(other, t, box)).toBeNull();
    expect(openFor(k, topicFor(k, 6), box)).toBeNull();
    expect(openFor(k, t, box.slice(0, -2) + "AA")).toBeNull();
    expect(openFor(k, t, "garbage!")).toBeNull();
  });
});

describe("nostr events", () => {
  it("signs with a fresh key each time and verifies; any change breaks it", () => {
    const a = signEvent(RENDEZVOUS_KIND, [["t", "ab"]], "x", 100);
    const b = signEvent(RENDEZVOUS_KIND, [["t", "ab"]], "x", 100);
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(verifyEvent(a)).toBe(true);
    expect(verifyEvent({ ...a, content: "y" })).toBe(false);
    expect(verifyEvent({ ...a, sig: "0".repeat(128) })).toBe(false);
    expect(verifyEvent({ ...a, tags: [["t", 5]] })).toBe(false);
    expect(verifyEvent(null)).toBe(false);
  });
});

/** A relay network in memory: a published event reaches every pool whose filter matches. */
function bus() {
  const pools: Array<{ filter: NostrFilter | null; on: (e: NostrEvent) => void }> = [];
  const log: NostrEvent[] = [];
  const make = (): PoolLike & { closed: boolean } => {
    const me = { filter: null as NostrFilter | null, on: (_e: NostrEvent) => undefined as void };
    pools.push(me);
    return {
      closed: false,
      listen(on) {
        me.on = on;
      },
      subscribe(f) {
        me.filter = f;
      },
      publish(e) {
        log.push(e);
        for (const p of pools) if (p.filter && p.filter["#t"].includes(e.tags[0][1])) p.on(e);
        return 1;
      },
      close() {
        this.closed = true;
        me.filter = null;
      },
    };
  };
  return { make, log };
}

describe("rendezvous between two contacts", () => {
  let now = 1_763_200_000_000;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const net = bus();
    const offersAtB: string[] = [];
    const offersAtA: string[] = [];
    const contactOf = (p: typeof A, name: string) => ({ did: p.did, publicKey: p.kp.publicKey, name });
    const a = new Rendezvous({ myDid: A.did, mySecretKey: A.kp.secretKey, pool: net.make(), contacts: async () => [contactOf(B, "Б")], onOffer: (_c, inv) => offersAtA.push(inv), now: () => now });
    const b = new Rendezvous({ myDid: B.did, mySecretKey: B.kp.secretKey, pool: net.make(), contacts: async () => [contactOf(A, "А")], onOffer: (_c, inv) => offersAtB.push(inv), now: () => now });
    return { net, a, b, offersAtA, offersAtB, bAsContact: contactOf(B, "Б"), aAsContact: contactOf(A, "А") };
  }

  it("an offer reaches the listening contact once, and its answer comes back", async () => {
    const s = setup();
    await s.a.refresh();
    await s.b.refresh();
    const answers: string[] = [];
    s.a.call(s.bAsContact, "p2p1:OFFER", (inv) => answers.push(inv), () => undefined);
    expect(s.offersAtB).toEqual(["p2p1:OFFER"]);
    expect(s.offersAtA).toEqual([]); // our own echo is ignored
    vi.advanceTimersByTime(OFFER_REPEAT_MS);
    expect(s.offersAtB).toEqual(["p2p1:OFFER"]); // republished, handed on once
    s.b.answer(s.aAsContact, "p2p1:ANSWER");
    expect(answers).toEqual(["p2p1:ANSWER"]);
    // Relays see neither the invitations nor the dids.
    const wire = JSON.stringify(s.net.log);
    for (const secret of ["OFFER", "ANSWER", A.did, B.did]) expect(wire).not.toContain(secret);
  });

  it("it still meets after the topic rotates", async () => {
    const s = setup();
    await s.a.refresh();
    await s.b.refresh();
    now += EPOCH_MS;
    vi.advanceTimersByTime(EPOCH_MS);
    s.a.call(s.bAsContact, "p2p1:LATER", () => undefined, () => undefined);
    expect(s.offersAtB).toEqual(["p2p1:LATER"]);
  });

  it("when both search, the smaller did's offer stands and the other answers it", async () => {
    const s = setup();
    await s.a.refresh();
    await s.b.refresh();
    const theirsAtA: string[] = [];
    const theirsAtB: string[] = [];
    s.a.call(s.bAsContact, "p2p1:FROMA", () => undefined, (inv) => theirsAtA.push(inv));
    s.b.call(s.aAsContact, "p2p1:FROMB", () => undefined, (inv) => theirsAtB.push(inv));
    vi.advanceTimersByTime(OFFER_REPEAT_MS);
    await Promise.resolve();
    const smallerIsA = A.did < B.did;
    expect(theirsAtA).toEqual(smallerIsA ? [] : ["p2p1:FROMB"]);
    expect(theirsAtB).toEqual(smallerIsA ? ["p2p1:FROMA"] : []);
  });

  it("a stranger on the same relays cannot inject an offer", async () => {
    const s = setup();
    await s.b.refresh();
    const k = pairKey(C.kp.secretKey, C.did, B.kp.publicKey, B.did);
    const t = topicFor(k, epochOf(now));
    s.net.make().publish(signEvent(RENDEZVOUS_KIND, [["t", t]], sealFor(k, t, { k: "offer", inv: "p2p1:EVIL", f: A.did }), 1));
    expect(s.offersAtB).toEqual([]);
  });

  it("stop() closes the pool and ends the calls", async () => {
    const net = bus();
    const pool = net.make();
    const r = new Rendezvous({ myDid: A.did, mySecretKey: A.kp.secretKey, pool, contacts: async () => [], onOffer: () => undefined, now: () => now });
    r.call({ did: B.did, publicKey: B.kp.publicKey, name: "Б" }, "p2p1:X", () => undefined, () => undefined);
    const before = net.log.length;
    r.stop();
    vi.advanceTimersByTime(OFFER_REPEAT_MS * 3);
    expect(net.log.length).toBe(before);
    expect(pool.closed).toBe(true);
  });
});

describe("relay pool", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  class FakeSocket implements SocketLike {
    readyState = 0;
    sent: string[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public url: string) {}
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    drop() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }

  it("subscribes on open and again after a reconnect; publishes to open relays; drops bad and repeated events", () => {
    const sockets: FakeSocket[] = [];
    const pool = new RelayPool(["wss://a", "wss://b"], (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    });
    const got: string[] = [];
    pool.listen((e) => got.push(e.id));
    pool.subscribe({ kinds: [RENDEZVOUS_KIND], "#t": ["aa"] });
    sockets[0].open();
    expect(sockets[0].sent.some((m) => m.startsWith('["REQ","rv"'))).toBe(true);
    expect(pool.openCount).toBe(1);
    const ev = signEvent(RENDEZVOUS_KIND, [["t", "aa"]], "c", 1);
    expect(pool.publish(ev)).toBe(1);
    sockets[0].onmessage?.({ data: JSON.stringify(["EVENT", "rv", ev]) });
    sockets[0].onmessage?.({ data: JSON.stringify(["EVENT", "rv", ev]) });
    sockets[0].onmessage?.({ data: JSON.stringify(["EVENT", "rv", { ...ev, content: "forged" }]) });
    sockets[0].onmessage?.({ data: "not json" });
    expect(got).toEqual([ev.id]);
    sockets[0].drop();
    vi.advanceTimersByTime(2000);
    const again = sockets[2];
    expect(again.url).toBe("wss://a");
    again.open();
    expect(again.sent.some((m) => m.startsWith('["REQ","rv"'))).toBe(true);
    pool.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBe(3);
  });
});
