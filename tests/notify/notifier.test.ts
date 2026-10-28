import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFY,
  PREVIEW_CHARS,
  decide,
  loadNotifySettings,
  previewText,
  saveNotifySettings,
  type NotifySettings,
} from "../../src/notify/notifier";
import { DEFAULT_SOUND, SCORES, SOUNDS, isSoundId, playSound, type AudioLike } from "../../src/notify/sounds";

const on: NotifySettings = { ...DEFAULT_NOTIFY, enabled: true, sound: "chime" };
const known = { known: true };

describe("when a message makes a sound or a notification", () => {
  it("says nothing while you are reading that chat", () => {
    expect(decide(known, { visible: true, open: true, permission: "granted" }, on)).toEqual({ sound: false, system: false, unread: false });
  });

  it("only plays the sound when the window is in front but another screen is open", () => {
    expect(decide(known, { visible: true, open: false, permission: "granted" }, on)).toEqual({ sound: true, system: false, unread: false });
  });

  it("plays, notifies and counts when the window is in the background", () => {
    expect(decide(known, { visible: false, open: true, permission: "granted" }, on)).toEqual({ sound: true, system: true, unread: true });
  });

  it("does not show a system notification without permission, but still plays and counts", () => {
    for (const permission of ["default", "denied", "unsupported"]) {
      expect(decide(known, { visible: false, open: false, permission }, on)).toEqual({ sound: true, system: false, unread: true });
    }
  });

  it("is silent for someone who is not a contact or group member, and when switched off", () => {
    expect(decide({ known: false }, { visible: false, open: false, permission: "granted" }, on).system).toBe(false);
    expect(decide({ known: false }, { visible: false, open: false, permission: "granted" }, on).sound).toBe(false);
    expect(decide(known, { visible: false, open: false, permission: "granted" }, { ...on, enabled: false })).toEqual({ sound: false, system: false, unread: false });
  });

  it("with 'no sound' it still notifies, without the sound", () => {
    expect(decide(known, { visible: false, open: false, permission: "granted" }, { ...on, sound: "none" })).toEqual({ sound: false, system: true, unread: true });
  });
});

describe("notification settings", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("keep the message text out of notifications by default", () => {
    expect(DEFAULT_NOTIFY.showText).toBe(false);
    expect(loadNotifySettings(mem())).toEqual(DEFAULT_NOTIFY);
  });

  it("are saved and read back", () => {
    const s = mem();
    saveNotifySettings({ enabled: false, sound: "voice-ola", volume: 0.3, showText: true }, s);
    expect(loadNotifySettings(s)).toEqual({ enabled: false, sound: "voice-ola", volume: 0.3, showText: true });
  });

  it("ignore broken or unknown values field by field", () => {
    const s = mem();
    s.setItem("p2p.notify", JSON.stringify({ enabled: "yes", sound: "trumpet", volume: 7, showText: true }));
    expect(loadNotifySettings(s)).toEqual({ ...DEFAULT_NOTIFY, showText: true });
    s.setItem("p2p.notify", "{not json");
    expect(loadNotifySettings(s)).toEqual(DEFAULT_NOTIFY);
  });

  it("do not throw when storage is blocked", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadNotifySettings(blocked)).toEqual(DEFAULT_NOTIFY);
    expect(() => saveNotifySettings(DEFAULT_NOTIFY, blocked)).not.toThrow();
  });
});

describe("message preview", () => {
  it("is one line and at most 80 characters", () => {
    expect(previewText("  Здрасти\n\nкак си?  ")).toBe("Здрасти как си?");
    const long = previewText("а".repeat(300));
    expect(long.length).toBe(PREVIEW_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });
});

/* ------------------------------------------------------------------ sounds */

/** A fake AudioContext that records the nodes a score creates and when they start and stop. */
function fakeAudio() {
  const log = { oscillators: 0, filters: 0, buffers: 0, stops: [] as number[], connections: 0 };
  const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ connect: () => { log.connections++; } });
  const ctx = {
    currentTime: 10,
    sampleRate: 8000,
    destination: node(),
    createOscillator: () => { log.oscillators++; return { ...node(), type: "", frequency: param(), start() {}, stop: (t: number) => log.stops.push(t) }; },
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => { log.filters++; return { ...node(), type: "", frequency: param(), Q: param() }; },
    createBuffer: (_c: number, n: number) => { log.buffers++; const d = new Float32Array(n); return { getChannelData: () => d }; },
    createBufferSource: () => ({ ...node(), buffer: null, start() {}, stop: (t: number) => log.stops.push(t) }),
  };
  return { ctx: ctx as unknown as AudioLike, log };
}

describe("notification sounds", () => {
  it("offers several sounds, including sung ones, and 'no sound'", () => {
    expect(SOUNDS.length).toBeGreaterThanOrEqual(6);
    expect(SOUNDS.filter((s) => s.id.startsWith("voice") || s.id === "choir").length).toBeGreaterThanOrEqual(3);
    expect(SOUNDS.some((s) => s.id === "none")).toBe(true);
    expect(isSoundId(DEFAULT_SOUND)).toBe(true);
    expect(new Set(SOUNDS.map((s) => s.id)).size).toBe(SOUNDS.length);
  });

  it("every sound is short and stops all it starts", () => {
    for (const s of SOUNDS) {
      if (s.id === "none") continue;
      const { ctx, log } = fakeAudio();
      const length = SCORES[s.id](ctx, ctx.destination as unknown as AudioNode, ctx.currentTime);
      expect(length, s.id).toBeGreaterThan(0.2);
      expect(length, s.id).toBeLessThanOrEqual(1.5);
      expect(log.stops.length, s.id).toBeGreaterThan(0);
      for (const t of log.stops) expect(t - ctx.currentTime, s.id).toBeLessThanOrEqual(1.6);
    }
  });

  it("the voices are sung through formant filters", () => {
    for (const id of ["voice-ola", "voice-hey", "choir"] as const) {
      const { ctx, log } = fakeAudio();
      SCORES[id](ctx, ctx.destination as unknown as AudioNode, 0);
      expect(log.filters, id).toBeGreaterThanOrEqual(3);
    }
  });

  it("plays nothing for 'no sound', zero volume or a missing audio system", () => {
    const { ctx, log } = fakeAudio();
    expect(playSound("none", 1, ctx)).toBe(false);
    expect(playSound("chime", 0, ctx)).toBe(false);
    expect(playSound("chime", 1, null)).toBe(false);
    expect(log.oscillators).toBe(0);
    expect(playSound("chime", 0.5, ctx)).toBe(true);
    expect(log.oscillators).toBeGreaterThan(0);
  });
});
