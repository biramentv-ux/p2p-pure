import { describe, it, expect, vi, afterEach } from "vitest";
import type { PluginListenerHandle } from "@capacitor/core";
import {
  BlePairingSession,
  FrameAssembler,
  base64ToBytes,
  bytesToBase64,
  encodeFrames,
  isBleSupported,
  newBleTag,
  BLE_TAG_ALPHABET,
  type BleDevice,
  type BlePairingPlugin,
} from "../../src/platform/mobile/blePairing";

const SHORT = "p2p1." + "A".repeat(745);
const LONG = "p2p1." + "xЖ".repeat(5000); // multi-byte, ~15 KB, <= 16 KiB
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("helpers", () => {
  it("isBleSupported only on android/ios", () => {
    expect(isBleSupported("android")).toBe(true);
    expect(isBleSupported("ios")).toBe(true);
    expect(isBleSupported("web")).toBe(false);
  });
  it("newBleTag uses the alphabet and injected random", () => {
    expect(newBleTag(() => 0)).toBe("2222");
    expect(newBleTag(() => 0.999999)).toBe("ZZZZ");
    for (const c of newBleTag()) expect(BLE_TAG_ALPHABET).toContain(c);
  });
  it("base64 is standard with padding", () => {
    const b = new Uint8Array([251, 255, 254, 1]);
    const s = bytesToBase64(b);
    expect(s).toBe("+//+AQ==");
    expect(base64ToBytes(s)).toEqual(b);
  });
});

describe("framing", () => {
  for (const mtu of [23, 185, 517]) {
    for (const [name, msg] of [["750 chars", SHORT], ["16 KiB", "p2p1." + "é".repeat(8189) + "a".repeat(0)]] as const) {
      it(`round-trips ${name} at MTU ${mtu}`, () => {
        const frames = encodeFrames(msg, mtu, 0xabcd);
        for (const f of frames) expect(f.length).toBeLessThanOrEqual(mtu - 3);
        const asm = new FrameAssembler();
        let out: string | null = null;
        for (const f of [...frames].reverse()) out = asm.push(f);
        expect(out).toBe(msg);
      });
    }
  }

  it("handles multi-byte text", () => {
    const frames = encodeFrames(LONG, 185, 1);
    const asm = new FrameAssembler();
    let out: string | null = null;
    for (const f of frames) out = asm.push(f);
    expect(out).toBe(LONG);
  });

  it("uses the documented header", () => {
    const [f] = encodeFrames("hi", 517, 0x0102);
    expect([...f.slice(0, 7)]).toEqual([1, 1, 2, 0, 0, 0, 1]);
  });

  it("rejects oversize messages when encoding", () => {
    expect(() => encodeFrames("a".repeat(16 * 1024 + 1), 517, 1)).toThrow(/голяма/);
  });

  it("rejects wrong version", () => {
    const [f] = encodeFrames("hello", 517, 1);
    f[0] = 2;
    expect(() => new FrameAssembler().push(f)).toThrow(/повреден/);
  });
  it("rejects short frames", () => {
    expect(() => new FrameAssembler().push(new Uint8Array(3))).toThrow(/повреден/);
  });
  it("rejects duplicates", () => {
    const frames = encodeFrames(SHORT, 23, 5);
    const asm = new FrameAssembler();
    asm.push(frames[0]);
    expect(() => asm.push(frames[0])).toThrow(/повреден/);
  });
  it("rejects out-of-range index", () => {
    const [f] = encodeFrames("hello", 517, 5);
    f[4] = 3;
    expect(() => new FrameAssembler().push(f)).toThrow(/повреден/);
  });
  it("rejects zero total", () => {
    const [f] = encodeFrames("hello", 517, 5);
    f[6] = 0;
    expect(() => new FrameAssembler().push(f)).toThrow(/повреден/);
  });
  it("rejects mismatched total and id", () => {
    const frames = encodeFrames(SHORT, 23, 5);
    const a = new FrameAssembler();
    a.push(frames[0]);
    const badTotal = frames[1].slice();
    badTotal[6] ^= 1;
    expect(() => a.push(badTotal)).toThrow(/повреден/);
    const b = new FrameAssembler();
    b.push(frames[0]);
    const badId = frames[1].slice();
    badId[2] ^= 1;
    expect(() => b.push(badId)).toThrow(/повреден/);
  });
  it("rejects oversize while assembling", () => {
    const asm = new FrameAssembler();
    const mk = (i: number) => {
      const f = new Uint8Array(7 + 9000);
      f.set([1, 0, 1, 0, i, 0, 3]);
      return f;
    };
    asm.push(mk(0));
    expect(() => asm.push(mk(1))).toThrow(/голяма/);
  });
});

type Handler = (e: never) => void;

class FakePlugin implements BlePairingPlugin {
  listeners = new Map<string, Set<Handler>>();
  stopped = 0;
  peer!: FakePlugin;
  role: "peripheral" | "central" | null = null;
  tag = "";
  mtu = 185;
  availability: { available: boolean; reason?: "unsupported" | "off" | "unauthorized" } = { available: true };
  granted = true;

  emit(event: string, payload: unknown) {
    for (const h of [...(this.listeners.get(event) ?? [])]) h(payload as never);
  }
  later(fn: () => void) {
    void Promise.resolve().then(fn);
  }
  listenerCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  async checkAvailability() {
    return this.availability;
  }
  async requestPermissions() {
    return { granted: this.granted };
  }
  async startPeripheral({ tag }: { tag: string }) {
    this.role = "peripheral";
    this.tag = tag;
  }
  async startScan() {
    this.role = "central";
    this.later(() => {
      if (this.peer.role === "peripheral") {
        const d: BleDevice = { deviceId: "dev-1", tag: this.peer.tag, rssi: -60 };
        this.emit("deviceFound", d);
        this.emit("deviceFound", { ...d, rssi: -50 });
      }
    });
  }
  async connect({ deviceId }: { deviceId: string }) {
    expect(deviceId).toBe("dev-1");
    this.later(() => {
      this.emit("connected", { mtu: this.mtu });
      this.peer.emit("subscribed", { mtu: this.mtu });
    });
    return { mtu: this.mtu };
  }
  async send({ data }: { data: string }) {
    this.later(() => this.peer.emit("data", { data }));
  }
  async stop() {
    this.stopped++;
  }
  async addListener(event: string, fn: Handler): Promise<PluginListenerHandle> {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return { remove: async () => void this.listeners.get(event)!.delete(fn) };
  }
}

function pair(mtu = 185) {
  const a = new FakePlugin();
  const b = new FakePlugin();
  a.peer = b;
  b.peer = a;
  a.mtu = b.mtu = mtu;
  return { initiator: a, responder: b };
}

afterEach(() => vi.useRealTimers());

describe("BlePairingSession", () => {
  for (const mtu of [23, 517]) {
    it(`completes a full exchange at MTU ${mtu}`, async () => {
      const { initiator, responder } = pair(mtu);
      const offer = LONG;
      const answer = "p2p1." + "Б".repeat(600);
      const gotAnswer = vi.fn();
      const gotOffer = vi.fn(async (o: string) => (o === offer ? answer : "bad"));
      let lastList: BleDevice[] = [];

      const si = new BlePairingSession(initiator, { random: () => 0.5 });
      const sr = new BlePairingSession(responder, { random: () => 0.25 });
      const pi = si.startAsInitiator({ tag: "AB23", offer, onAnswer: gotAnswer });
      const pr = sr.startAsResponder({ onDevices: (l) => (lastList = l), onOffer: gotOffer });
      await tick();
      await tick();
      expect(lastList).toHaveLength(1);
      expect(lastList[0]).toMatchObject({ tag: "AB23", rssi: -50 });
      await sr.pick(lastList[0].deviceId);
      await Promise.all([pi, pr]);

      expect(gotOffer).toHaveBeenCalledWith(offer);
      expect(gotAnswer).toHaveBeenCalledWith(answer);
      for (const p of [initiator, responder]) {
        expect(p.stopped).toBe(1);
        expect(p.listenerCount()).toBe(0);
      }
    });
  }

  it("fails with Bulgarian message when Bluetooth is off and still stops", async () => {
    const { initiator } = pair();
    initiator.availability = { available: false, reason: "off" };
    const s = new BlePairingSession(initiator);
    await expect(s.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() })).rejects.toThrow("Bluetooth е изключен.");
    expect(initiator.stopped).toBe(1);
    expect(initiator.listenerCount()).toBe(0);
  });

  it("fails when permission is denied", async () => {
    const { responder } = pair();
    responder.granted = false;
    const s = new BlePairingSession(responder);
    await expect(s.startAsResponder({ onDevices: vi.fn(), onOffer: vi.fn() })).rejects.toThrow("Няма разрешение за Bluetooth.");
    expect(responder.stopped).toBe(1);
  });

  it("times out after 60 s, removes listeners and stops", async () => {
    vi.useFakeTimers();
    const { initiator } = pair();
    const s = new BlePairingSession(initiator);
    const p = s.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() });
    const assertion = expect(p).rejects.toThrow("Времето за сдвояване изтече.");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(initiator.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(initiator.stopped).toBe(1);
    expect(initiator.listenerCount()).toBe(0);
  });

  it("fails on disconnect mid-transfer", async () => {
    const { initiator } = pair();
    const si = new BlePairingSession(initiator);
    const pi = si.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() });
    await tick();
    initiator.emit("disconnected", {});
    await expect(pi).rejects.toThrow("Връзката по Bluetooth прекъсна.");
    expect(initiator.stopped).toBe(1);
  });

  it("fails on native error events and corrupt data", async () => {
    const { initiator } = pair();
    const s1 = new BlePairingSession(initiator);
    const p1 = s1.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() });
    await tick();
    initiator.emit("error", { message: "boom" });
    await expect(p1).rejects.toThrow(/Грешка при Bluetooth/);

    const s2 = new BlePairingSession(initiator);
    const p2 = s2.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() });
    await tick();
    initiator.emit("data", { data: bytesToBase64(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])) });
    await expect(p2).rejects.toThrow(/повреден/);
    expect(initiator.listenerCount()).toBe(0);
  });

  it("cancel resolves quietly and cleans up", async () => {
    const { initiator } = pair();
    const s = new BlePairingSession(initiator);
    const p = s.startAsInitiator({ tag: "AB23", offer: "x", onAnswer: vi.fn() });
    await tick();
    s.cancel();
    await expect(p).resolves.toBeUndefined();
    expect(initiator.stopped).toBe(1);
    expect(initiator.listenerCount()).toBe(0);
  });
});
