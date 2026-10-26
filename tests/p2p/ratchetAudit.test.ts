/**
 * Cross-checks of the custom Double Ratchet (src/p2p/secureSession.ts) against an
 * independent reference written from the Signal specification (ratchetReference.ts).
 * See docs/RATCHET-AUDIT.md for what these tests show and what they cannot show.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { mnemonicToSeed } from "../../src/identity/mnemonic";
import {
  createEphemeralKeyPair,
  MAX_SKIP,
  MAX_SKIPPED_TOTAL,
  SecureSession,
  SessionError,
  type EphemeralKeyPair,
} from "../../src/p2p/secureSession";
import { RefRatchet, refRootKey, kdfCk, kdfRk, hkdfSha256, hmacSha256, b64u, unb64u, type RefSuite } from "./ratchetReference";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

const M1 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const M2 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const alice = deriveIdentityKeyPair(mnemonicToSeed(M1));
const bob = deriveIdentityKeyPair(mnemonicToSeed(M2));

/** Small seeded PRNG so a failing loop can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function implPair(ephA = createEphemeralKeyPair(), ephB = createEphemeralKeyPair()) {
  const initiator = SecureSession.derive({
    role: "initiator", myIdentity: alice, myEphemeral: ephA,
    peerIdentityPublicKey: bob.publicKey, peerEphemeralPublicKey: ephB.publicKey,
  });
  const responder = SecureSession.derive({
    role: "responder", myIdentity: bob, myEphemeral: ephB,
    peerIdentityPublicKey: alice.publicKey, peerEphemeralPublicKey: ephA.publicKey,
  });
  return { initiator, responder, ephA, ephB };
}

interface Endpoint {
  kind: "impl" | "ref";
  seal(text: string, suite: RefSuite): Promise<string>;
  open(wire: string): Promise<string>;
}
function implEndpoint(s: SecureSession): Endpoint {
  return {
    kind: "impl",
    seal: (t, suite) => {
      s.setSendSuite(suite === "a" ? "aes-256-gcm" : "chacha20-poly1305");
      return s.seal(t);
    },
    open: (w) => s.open(w),
  };
}
function refEndpoint(r: RefRatchet): Endpoint {
  return { kind: "ref", seal: async (t, suite) => r.encrypt(t, suite), open: async (w) => r.decrypt(w) };
}

/** Builds the two ends of a session; each end is the production code or the reference. */
function world(a: "impl" | "ref", b: "impl" | "ref") {
  const ephA = createEphemeralKeyPair();
  const ephB = createEphemeralKeyPair();
  const impl = implPair(ephA, ephB);
  const rootA = refRootKey({ role: "initiator", myIdentity: alice, myEphemeral: ephA, peerIdentityPublicKey: bob.publicKey, peerEphemeralPublicKey: ephB.publicKey });
  const rootB = refRootKey({ role: "responder", myIdentity: bob, myEphemeral: ephB, peerIdentityPublicKey: alice.publicKey, peerEphemeralPublicKey: ephA.publicKey });
  expect(hex(rootA)).toBe(hex(rootB));
  const A = a === "impl" ? implEndpoint(impl.initiator) : refEndpoint(RefRatchet.initAlice(rootA, ephB.publicKey));
  const B = b === "impl" ? implEndpoint(impl.responder) : refEndpoint(RefRatchet.initBob(rootB, ephB));
  return { A, B };
}

async function rejects(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(SessionError);
}
const mutateWire = (wire: string, f: (m: Record<string, unknown>) => void): string => {
  const m = JSON.parse(wire) as Record<string, unknown>;
  f(m);
  return JSON.stringify(m);
};
const internals = (s: SecureSession) => s as unknown as { skipped: Map<string, Uint8Array> };

afterEach(() => vi.restoreAllMocks());

describe("primitives: published known-answer vectors", () => {
  it("HKDF-SHA256 matches RFC 5869 test case 1 (noble and node:crypto)", () => {
    const ikm = unhex("0b".repeat(22));
    const salt = unhex("000102030405060708090a0b0c");
    const info = unhex("f0f1f2f3f4f5f6f7f8f9");
    const okm = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";
    expect(hex(hkdf(nobleSha256, ikm, salt, info, 42))).toBe(okm);
    expect(hex(hkdfSha256(ikm, salt, info, 42))).toBe(okm);
  });

  it("HMAC-SHA256 matches RFC 4231 test case 1 (noble and node:crypto)", () => {
    const key = unhex("0b".repeat(20));
    const data = new TextEncoder().encode("Hi There");
    const tag = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
    expect(hex(hmac(nobleSha256, key, data))).toBe(tag);
    expect(hex(hmacSha256(key, data))).toBe(tag);
  });

  it("KDF_CK uses the spec constants: 0x01 -> message key, 0x02 -> next chain key", () => {
    const ck = unhex("00".repeat(32));
    const [mk, next] = kdfCk(ck);
    expect(hex(mk)).toBe(hex(hmac(nobleSha256, ck, Uint8Array.of(1))));
    expect(hex(next)).toBe(hex(hmac(nobleSha256, ck, Uint8Array.of(2))));
    expect(hex(mk)).not.toBe(hex(next));
  });

  it("KDF_RK is HKDF with the root key as salt and the DH output as input key material", () => {
    const rk = unhex("11".repeat(32));
    const dhOut = unhex("22".repeat(32));
    const [rk2, ck] = kdfRk(rk, dhOut);
    const direct = hkdf(nobleSha256, dhOut, rk, new TextEncoder().encode("p2p-messenger/session/ratchet/v2"), 64);
    expect(hex(rk2)).toBe(hex(direct.slice(0, 32)));
    expect(hex(ck)).toBe(hex(direct.slice(32)));
  });
});

describe("golden vector with a deterministic RNG", () => {
  it("first message of a fixed session is byte-for-byte stable and the reference decrypts it", async () => {
    let counter = 1;
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (counter++ * 37 + i) & 0xff;
      return arr;
    }) as typeof crypto.getRandomValues);
    const ephA = createEphemeralKeyPair();
    const ephB = createEphemeralKeyPair();
    const { initiator } = implPair(ephA, ephB);
    const wire = await initiator.seal("golden");
    vi.restoreAllMocks();

    const rootB = refRootKey({ role: "responder", myIdentity: bob, myEphemeral: ephB, peerIdentityPublicKey: alice.publicKey, peerEphemeralPublicKey: ephA.publicKey });
    expect(hex(rootB)).toBe(GOLDEN.root);
    expect(wire).toBe(GOLDEN.wire);
    const ref = RefRatchet.initBob(rootB, ephB as EphemeralKeyPair);
    expect(ref.decrypt(wire)).toBe("golden");
  });
});

// Pinned output of the current implementation (regression pin; the root key is also computed by the
// independent reference above, and the reference decrypts the wire message).
const GOLDEN = {
  root: "551c1e4bc7fcc239e815c02472a4b58bf0f03bcc2f1aa53a5f321d92cb69265d",
  wire: '{"t":"msg","s":"a","n":0,"pn":0,"dh":"6tw9e5SqQOSUeS8kjphlh4MWv4yg7NwbPk1JF9JkAGY","iv":"9RtBZ42z2f8lS3GX","ct":"oLbJQAED1zTaVRewBqzxlA2d_QCa_w"}',
};

describe("interoperability with the reference (random scripts, out-of-order delivery)", () => {
  const combos: ["impl" | "ref", "impl" | "ref"][] = [["impl", "impl"], ["impl", "ref"], ["ref", "impl"], ["ref", "ref"]];
  for (const [ka, kb] of combos) {
    it(`${ka} initiator <-> ${kb} responder, 12 seeds x 90 steps`, async () => {
      for (let seed = 1; seed <= 12; seed++) {
        const rng = mulberry32(seed * 7919);
        const { A, B } = world(ka, kb);
        const queue: { A: { wire: string; text: string }[]; B: { wire: string; text: string }[] } = { A: [], B: [] };
        let bCanSend = false;
        let id = 0;
        const deliver = async (to: "A" | "B") => {
          const q = queue[to];
          // 70% in order, otherwise one of the next 4 (bounded reordering).
          const idx = rng() < 0.7 ? 0 : Math.floor(rng() * Math.min(4, q.length));
          const [m] = q.splice(idx, 1);
          const got = await (to === "A" ? A : B).open(m.wire);
          expect(got, `seed ${seed}`).toBe(m.text);
          if (to === "B") bCanSend = true;
        };
        for (let step = 0; step < 90; step++) {
          const r = rng();
          if (r < 0.55) {
            const fromB = bCanSend && rng() < 0.5;
            const text = `m${id++} привет ${seed}`;
            const suite: RefSuite = rng() < 0.5 ? "a" : "c";
            const wire = await (fromB ? B : A).seal(text, suite);
            queue[fromB ? "A" : "B"].push({ wire, text });
          } else {
            const to = rng() < 0.5 ? "A" : "B";
            if (queue[to].length > 0) await deliver(to);
          }
        }
        for (const to of ["A", "B"] as const) while (queue[to].length) await deliver(to);
      }
    }, 60_000);
  }

  it("wire headers: dh changes on every direction switch, pn is the length of the previous chain", async () => {
    const { initiator: a, responder: b } = implPair();
    const hdr = (w: string) => JSON.parse(w) as { n: number; pn: number; dh: string };
    const a1 = hdr(await a.seal("1"));
    const a2 = hdr(await a.seal("2"));
    const a3w = await a.seal("3");
    const a3 = hdr(a3w);
    expect([a1.n, a2.n, a3.n]).toEqual([0, 1, 2]);
    expect(a1.dh).toBe(a2.dh);
    expect(a1.dh).toBe(a3.dh);
    await b.open(await a.seal("x").then((w) => w)); // out of order is fine: b may read 4th first
    const b1w = await b.seal("r1");
    const b1 = hdr(b1w);
    expect(b1.dh).not.toBe(a1.dh);
    expect(b1.n).toBe(0);
    expect(b1.pn).toBe(0);
    await a.open(b1w);
    const a4 = hdr(await a.seal("again"));
    expect(a4.dh).not.toBe(a1.dh);
    expect(a4.dh).not.toBe(b1.dh);
    expect(a4.n).toBe(0);
    expect(a4.pn).toBe(4); // four messages in the previous sending chain
  });

  it("every ratchet public key is fresh: no dh value is ever reused by a side", async () => {
    const { initiator: a, responder: b } = implPair();
    const seen = { a: new Set<string>(), b: new Set<string>() };
    let lastA = "", lastB = "";
    await b.open(await a.seal("start"));
    for (let i = 0; i < 40; i++) {
      const wb = await b.seal(`b${i}`);
      const db = (JSON.parse(wb) as { dh: string }).dh;
      if (db !== lastB) { expect(seen.b.has(db)).toBe(false); seen.b.add(db); lastB = db; }
      await a.open(wb);
      const wa = await a.seal(`a${i}`);
      const da = (JSON.parse(wa) as { dh: string }).dh;
      if (da !== lastA) { expect(seen.a.has(da)).toBe(false); seen.a.add(da); lastA = da; }
      await b.open(wa);
    }
    expect(seen.a.size).toBeGreaterThanOrEqual(40);
    expect(seen.b.size).toBe(40);
  });
});

describe("skipped keys and MAX_SKIP versus the reference", () => {
  it("accepts exactly MAX_SKIP skipped and refuses MAX_SKIP + 1, like the reference", async () => {
    for (const kind of ["impl", "ref"] as const) {
      for (const gap of [MAX_SKIP, MAX_SKIP + 1]) {
        const { A, B } = world("impl", kind);
        for (let i = 0; i < gap; i++) await A.seal("lost", "a");
        const w = await A.seal("edge", "a");
        if (gap <= MAX_SKIP) expect(await B.open(w)).toBe("edge");
        else await expect(B.open(w)).rejects.toBeDefined();
      }
    }
  });

  it("skipping across a DH ratchet (pn) also respects MAX_SKIP and keeps late messages decryptable", async () => {
    const { initiator: a, responder: b } = implPair();
    await b.open(await a.seal("first"));
    const lateFromA: string[] = [];
    for (let i = 0; i < 5; i++) lateFromA.push(await a.seal(`late${i}`));
    const reply = await b.seal("reply");
    await a.open(reply);
    const newChain = await a.seal("new chain"); // pn = 6
    expect(await b.open(newChain)).toBe("new chain");
    for (let i = 4; i >= 0; i--) expect(await b.open(lateFromA[i])).toBe(`late${i}`);
    expect(internals(b).skipped.size).toBe(0);
  });

  it("a header with a huge pn or n is refused without changing the state", async () => {
    const { initiator: a, responder: b } = implPair();
    const w1 = await a.seal("one");
    for (const field of ["n", "pn"] as const) {
      await rejects(b.open(mutateWire(w1, (m) => { m[field] = MAX_SKIP + 50; })));
      await rejects(b.open(mutateWire(w1, (m) => { m[field] = 0xffffffff; })));
    }
    expect(await b.open(w1)).toBe("one");
  });

  it("a used skipped key is deleted from the cache (single use, no accumulation)", async () => {
    const { initiator: a, responder: b } = implPair();
    const ws = [];
    for (let i = 0; i < 20; i++) ws.push(await a.seal(`m${i}`));
    await b.open(ws[19]);
    expect(internals(b).skipped.size).toBe(19);
    for (let i = 0; i < 19; i++) await b.open(ws[i]);
    expect(internals(b).skipped.size).toBe(0);
    await rejects(b.open(ws[3]));
  });

  it("a tampered message for a cached key does not burn the key", async () => {
    const { initiator: a, responder: b } = implPair();
    const w0 = await a.seal("keep");
    const w1 = await a.seal("next");
    await b.open(w1);
    const bad = mutateWire(w0, (m) => { m.ct = (m.ct as string).replace(/^./, (c) => (c === "A" ? "B" : "A")); });
    await rejects(b.open(bad));
    expect(await b.open(w0)).toBe("keep");
  });
});

describe("total skipped-key store is bounded (spec 8.4)", () => {
  it("a peer that keeps skipping MAX_SKIP messages cannot grow the cache past MAX_SKIPPED_TOTAL", async () => {
    const { initiator: a, responder: b } = implPair();
    const first: string[] = [];
    const last: string[] = [];
    const rounds = Math.ceil(MAX_SKIPPED_TOTAL / MAX_SKIP) + 4;
    for (let r = 0; r < rounds; r++) {
      const batch: string[] = [];
      for (let i = 0; i < MAX_SKIP; i++) batch.push(await a.seal(`r${r}.${i}`));
      const delivered = await a.seal(`r${r}.delivered`);
      expect(await b.open(delivered)).toBe(`r${r}.delivered`);
      if (r === 0) first.push(...batch);
      if (r === rounds - 1) last.push(...batch);
      expect(internals(b).skipped.size).toBeLessThanOrEqual(MAX_SKIPPED_TOTAL);
    }
    expect(internals(b).skipped.size).toBe(MAX_SKIPPED_TOTAL);
    // Newest skipped keys are kept, the oldest were evicted, and the session still works.
    expect(await b.open(last[5])).toBe(`r${rounds - 1}.5`);
    await rejects(b.open(first[0]));
    expect(await b.open(await a.seal("alive"))).toBe("alive");
  }, 60_000);
});

describe("replay, tamper and AAD", () => {
  it("replays are rejected in the current chain, after a DH ratchet, and leave the session working", async () => {
    const { initiator: a, responder: b } = implPair();
    const w1 = await a.seal("1");
    await b.open(w1);
    await a.open(await b.seal("r"));
    const w2 = await a.seal("2");
    await b.open(w2);
    await rejects(b.open(w1)); // old chain, key consumed
    await rejects(b.open(w2)); // current chain
    const w3 = await a.seal("3");
    expect(await b.open(w3)).toBe("3");
  });

  it("every header field is authenticated: changing n, pn, dh or the suite tag is rejected, and the original still opens", async () => {
    for (const suite of ["aes-256-gcm", "chacha20-poly1305"] as const) {
      const { initiator: a, responder: b } = implPair();
      a.setSendSuite(suite);
      await b.open(await a.seal("warmup"));
      await a.open(await b.seal("reply"));
      const w = await a.seal("payload");
      const m = JSON.parse(w) as { n: number; pn: number; dh: string; s: string };
      const otherDh = b64u(createEphemeralKeyPair().publicKey);
      const variants = [
        mutateWire(w, (x) => { x.n = m.n + 1; }),
        mutateWire(w, (x) => { x.n = m.n + 3; }),
        mutateWire(w, (x) => { x.pn = m.pn + 1; }),
        mutateWire(w, (x) => { x.pn = m.pn === 0 ? 1 : m.pn - 1; }),
        mutateWire(w, (x) => { x.dh = otherDh; }),
        mutateWire(w, (x) => { x.s = m.s === "a" ? "c" : "a"; }),
      ];
      // Legacy untagged format means AES-GCM: for ChaCha it must fail, for AES it is the same message.
      if (suite === "chacha20-poly1305") variants.push(mutateWire(w, (x) => { delete x.s; }));
      for (const v of variants) {
        if (v === w) continue;
        await expect(b.open(v)).rejects.toBeInstanceOf(SessionError);
      }
      expect(await b.open(w)).toBe("payload");
    }
  });

  it("random single-character corruption of ct or iv is always rejected (both suites)", async () => {
    const rng = mulberry32(4242);
    for (const suite of ["aes-256-gcm", "chacha20-poly1305"] as const) {
      const { initiator: a, responder: b } = implPair();
      a.setSendSuite(suite);
      for (let i = 0; i < 40; i++) {
        const w = await a.seal(`msg ${i} ${"x".repeat(i)}`);
        const field = rng() < 0.5 ? "ct" : "iv";
        const bad = mutateWire(w, (m) => {
          const s = m[field] as string;
          const pos = Math.floor(rng() * (s.length - 2)); // not the last char: it carries padding bits
          const repl = s[pos] === "A" ? "B" : "A";
          m[field] = s.slice(0, pos) + repl + s.slice(pos + 1);
        });
        await rejects(b.open(bad));
        expect(await b.open(w)).toBe(`msg ${i} ${"x".repeat(i)}`);
      }
    }
  });

  it("truncated tag, empty ciphertext and extra bytes are rejected", async () => {
    const { initiator: a, responder: b } = implPair();
    const w = await a.seal("hello");
    const ct = unb64u((JSON.parse(w) as { ct: string }).ct);
    for (const bad of [ct.slice(0, ct.length - 1), ct.slice(0, 15), new Uint8Array(0), Uint8Array.of(...ct, 0)]) {
      await rejects(b.open(mutateWire(w, (m) => { m.ct = b64u(bad); })));
    }
    expect(await b.open(w)).toBe("hello");
  });

  it("a message reflected back to its sender is rejected (direction byte in the AAD)", async () => {
    for (const suite of ["aes-256-gcm", "chacha20-poly1305"] as const) {
      const { initiator: a, responder: b } = implPair();
      a.setSendSuite(suite);
      const w = await a.seal("mine");
      await b.open(w);
      await rejects(a.open(w));
    }
  });

  it("low-order and malformed ratchet public keys are rejected without touching the state", async () => {
    const { initiator: a, responder: b } = implPair();
    const w = await a.seal("ok");
    const lowOrder = [new Uint8Array(32), Uint8Array.of(1, ...new Uint8Array(31))];
    for (const pt of lowOrder) await rejects(b.open(mutateWire(w, (m) => { m.dh = b64u(pt); })));
    await rejects(b.open(mutateWire(w, (m) => { m.dh = b64u(new Uint8Array(31)); })));
    await rejects(b.open(mutateWire(w, (m) => { m.dh = b64u(new Uint8Array(33)); })));
    expect(await b.open(w)).toBe("ok");
  });

  it("a responder cannot send before it has received", async () => {
    const { responder: b } = implPair();
    await rejects(b.seal("too early"));
  });

  it("a forged first message cannot establish a receiving chain", async () => {
    const { responder: b } = implPair();
    const forged = JSON.stringify({ t: "msg", s: "a", n: 0, pn: 0, dh: b64u(createEphemeralKeyPair().publicKey), iv: b64u(new Uint8Array(12)), ct: b64u(new Uint8Array(32)) });
    await rejects(b.open(forged));
    await rejects(b.seal("still nothing"));
  });
});

describe("nonces and message keys", () => {
  it("3000 seals: no IV, ciphertext or (dh, n) pair repeats, even for identical plaintext", async () => {
    const { initiator: a } = implPair();
    const ivs = new Set<string>(), cts = new Set<string>(), ids = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const w = await a.seal("same plaintext");
      const m = JSON.parse(w) as { iv: string; ct: string; dh: string; n: number };
      ivs.add(m.iv); cts.add(m.ct); ids.add(`${m.dh}:${m.n}`);
    }
    expect(ivs.size).toBe(3000);
    expect(cts.size).toBe(3000);
    expect(ids.size).toBe(3000);
  });

  it("the message key is derived from the chain key only: two different messages never share a key", async () => {
    // Observable consequence: decrypting message k with the key of message j (via the reference) fails.
    const ephA = createEphemeralKeyPair();
    const ephB = createEphemeralKeyPair();
    const { initiator } = implPair(ephA, ephB);
    const w0 = await initiator.seal("zero");
    const w1 = await initiator.seal("one");
    const rootB = refRootKey({ role: "responder", myIdentity: bob, myEphemeral: ephB, peerIdentityPublicKey: alice.publicKey, peerEphemeralPublicKey: ephA.publicKey });
    const ref = RefRatchet.initBob(rootB, ephB as EphemeralKeyPair);
    expect(ref.decrypt(w0)).toBe("zero");
    expect(ref.decrypt(w1)).toBe("one");
    expect(() => ref.decrypt(w1)).toThrow(); // key already used and deleted in the reference as well
  });
});

describe("concurrency", () => {
  it("many parallel seal() calls produce unique, in-order counters and all decrypt", async () => {
    const { initiator: a, responder: b } = implPair();
    const wires = await Promise.all(Array.from({ length: 50 }, (_, i) => a.seal(`p${i}`)));
    const ns = wires.map((w) => (JSON.parse(w) as { n: number }).n);
    expect(ns).toEqual(Array.from({ length: 50 }, (_, i) => i));
    const out = await Promise.all(wires.map((w) => b.open(w)));
    expect(out).toEqual(wires.map((_, i) => `p${i}`));
  });
});
