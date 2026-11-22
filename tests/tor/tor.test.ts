import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addOnionLine, isOnionV3, onionFromKey, readOnionLine } from "../../src/tor/onion";
import { encodeFrame, FrameSplitter, openTorChannel, TorChannelError, torKey } from "../../src/tor/torChannel";
import { torMismatch } from "../../src/tor/torPairing";
import { stripNativeLines } from "../../src/native/endpoint";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";
import type { TorBridge, TorEvent } from "../../src/tor/torBridge";

const DDG = "duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion";
const SDP = "v=0\r\ns=-\r\n";

describe("П6 onion addresses", () => {
  it("accepts real v3 addresses and checks the checksum", () => {
    expect(isOnionV3(DDG)).toBe(true);
    const k = new Uint8Array(32).fill(5);
    const mine = onionFromKey(k);
    expect(isOnionV3(mine)).toBe(true);
    expect(mine.endsWith("d.onion")).toBe(true);
    const broken = (mine[0] === "a" ? "b" : "a") + mine.slice(1);
    expect(isOnionV3(broken)).toBe(false);
    expect(isOnionV3("example.onion")).toBe(false);
    expect(isOnionV3(DDG.toUpperCase())).toBe(false);
  });

  it("rides in the SDP as one line that WebRTC never sees", () => {
    const sdp = addOnionLine(SDP, DDG);
    expect(readOnionLine(sdp)).toBe(DDG);
    expect(readOnionLine(SDP)).toBeNull();
    expect(stripNativeLines(sdp)).not.toContain("x-p2p-onion");
    expect(() => addOnionLine(SDP, "nope.onion")).toThrow();
  });

  it("says when only one side is onion-only", () => {
    const prep = { bridge: {} as TorBridge, onion: DDG };
    expect(torMismatch(prep, SDP)).toMatch(/Само през Tor/);
    expect(torMismatch(null, addOnionLine(SDP, DDG))).toMatch(/Само през Tor/);
    expect(torMismatch(prep, addOnionLine(SDP, DDG))).toBeNull();
    expect(torMismatch(null, SDP)).toBeNull();
  });
});

describe("П6 stream framing", () => {
  it("splits frames across any chunking", () => {
    const frames = [encodeFrame(0, new TextEncoder().encode("здрасти")), encodeFrame(1, new Uint8Array(3000).fill(7)), encodeFrame(2, new Uint8Array(32))];
    const all = Uint8Array.from(frames.flatMap((f) => [...f]));
    const s = new FrameSplitter();
    const got = [];
    for (let i = 0; i < all.length; i += 777) got.push(...s.push(all.slice(i, i + 777)));
    expect(got.map((f) => [f.type, f.payload.length])).toEqual([
      [0, 14],
      [1, 3000],
      [2, 32],
    ]);
  });

  it("any byte stream either splits or throws TorChannelError", () => {
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 64 }), { maxLength: 20 }), (chunks) => {
        const s = new FrameSplitter();
        try {
          for (const c of chunks) s.push(c);
        } catch (e) {
          expect(e).toBeInstanceOf(TorChannelError);
        }
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

/** Two fake Tor shells joined back to back: A's connect() opens an incoming stream at B. */
function fakeTor() {
  const sides: Record<"A" | "B", { handlers: Set<(e: TorEvent) => void> }> = { A: { handlers: new Set() }, B: { handlers: new Set() } };
  let next = 1;
  const peerOf = new Map<string, { side: "A" | "B"; id: number }>();
  const emit = (side: "A" | "B", e: TorEvent) => queueMicrotask(() => sides[side].handlers.forEach((h) => h(e)));
  const bridge = (me: "A" | "B", reachable = true): TorBridge => ({
    start: async () => DDG,
    connect: async () => {
      if (!reachable) throw new Error("descriptor not found");
      const a = next++;
      const b = next++;
      peerOf.set(`${me}:${a}`, { side: me === "A" ? "B" : "A", id: b });
      peerOf.set(`${me === "A" ? "B" : "A"}:${b}`, { side: me, id: a });
      emit(me === "A" ? "B" : "A", { id: b, kind: "open", incoming: true });
      return a;
    },
    send: async (id, bytes) => {
      const p = peerOf.get(`${me}:${id}`);
      if (p) emit(p.side, { id: p.id, kind: "data", data: bytes });
    },
    close: (id) => {
      const p = peerOf.get(`${me}:${id}`);
      if (p) emit(p.side, { id: p.id, kind: "close" });
    },
    onEvent: (h) => {
      sides[me].handlers.add(h);
      return () => sides[me].handlers.delete(h);
    },
  });
  return bridge;
}

describe("П6 Tor channel", () => {
  const a = createEphemeralKeyPair();
  const b = createEphemeralKeyPair();
  const nonce = new Uint8Array(16).fill(1);
  const keyA = torKey(a.secretKey, b.publicKey, nonce);
  const keyB = torKey(b.secretKey, a.publicKey, nonce);

  it("both sides derive the same key; hello proves the pairing; text and bytes flow", async () => {
    expect(keyA).toEqual(keyB);
    const make = fakeTor();
    const signal = { cancelled: false };
    const [chA, chB] = await Promise.all([
      openTorChannel({ bridge: make("A"), side: "A", key: keyA, peerOnion: DDG, timeoutMs: 2000, signal }),
      openTorChannel({ bridge: make("B"), side: "B", key: keyB, peerOnion: DDG, timeoutMs: 2000, signal }),
    ]);
    const got: string[] = [];
    chB.onMessage((t) => got.push(t));
    const bins: number[] = [];
    chA.onBinary((x) => bins.push(x.length));
    chA.send("здрасти");
    await chB.sendBinary(new Uint8Array(5000));
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["здрасти"]);
    expect(bins).toEqual([5000]);
    const closed: string[] = [];
    chB.onClose((r) => closed.push(r));
    chA.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toHaveLength(1);
  });

  it("a stranger who opens a stream to our onion is refused", async () => {
    const make = fakeTor();
    const signal = { cancelled: false };
    const wrong = torKey(createEphemeralKeyPair().secretKey, b.publicKey, nonce);
    const b2 = openTorChannel({ bridge: make("B"), side: "B", key: keyB, peerOnion: DDG, timeoutMs: 300, signal });
    const a2 = openTorChannel({ bridge: make("A"), side: "A", key: wrong, peerOnion: DDG, timeoutMs: 300, signal });
    await expect(b2).rejects.toThrow(TorChannelError);
    signal.cancelled = true;
    await expect(a2).rejects.toThrow(TorChannelError);
  });

  it("A keeps retrying while the onion is not reachable, and stops when cancelled", async () => {
    const make = fakeTor();
    const signal = { cancelled: false };
    const p = openTorChannel({ bridge: make("A", false), side: "A", key: keyA, peerOnion: DDG, timeoutMs: 200, signal });
    await expect(p).rejects.toThrow("tor timeout");
    signal.cancelled = true;
  });
});

describe("П6 on Android (TorPlugin)", () => {
  it("is not offered when the APK has no Tor library", async () => {
    const { torBridge } = await import("../../src/tor/torBridge");
    const win = { Capacitor: { isNativePlatform: () => true, Plugins: { Tor: { status: () => Promise.reject(new Error("unavailable")) } } } };
    expect(await torBridge(win as never)).toBeNull();
  });

  it("maps the plugin to the same commands as the desktop", async () => {
    const { torBridge } = await import("../../src/tor/torBridge");
    const sent: Array<[number, string]> = [];
    const plugin = {
      status: async () => ({ started: false }),
      start: async () => ({ onion: DDG }),
      connect: async () => ({ id: 7 }),
      send: async (o: { id: number; data: string }) => void sent.push([o.id, o.data]),
      close: async () => undefined,
      recv: async () => ({ events: [{ id: 7, kind: "data" as const, data: btoa("hi") }] }),
    };
    const bridge = await torBridge({ Capacitor: { isNativePlatform: () => true, Plugins: { Tor: plugin } } } as never);
    expect(bridge).not.toBeNull();
    expect(await bridge!.start()).toBe(DDG);
    expect(await bridge!.connect(DDG)).toBe(7);
    await bridge!.send(7, new TextEncoder().encode("hi"));
    expect(sent).toEqual([[7, btoa("hi")]]);
    const got = await new Promise<string>((resolve) => {
      const off = bridge!.onEvent((e) => {
        off();
        resolve(new TextDecoder().decode(e.data));
      });
    });
    expect(got).toBe("hi");
  });
});
