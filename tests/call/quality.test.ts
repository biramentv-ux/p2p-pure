import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEP_UP_AFTER_MS, VIDEO_STEPS, nextVideoStep, rateQuality, summarizeStats } from "../../src/call/quality";
import { CallController, DISCONNECTED_GRACE_MS, RESTART_MIN_GAP_MS } from "../../src/call/callController";
import type { CallSignal } from "../../src/call/signal";

describe("quality (pure)", () => {
  it("rates loss and round-trip time in three levels", () => {
    expect(rateQuality({ rttMs: null, lossPct: null, inKbps: null, outKbps: null })).toBe("unknown");
    expect(rateQuality({ rttMs: 80, lossPct: 0.5, inKbps: 1, outKbps: 1 })).toBe("good");
    expect(rateQuality({ rttMs: 300, lossPct: 0, inKbps: 1, outKbps: 1 })).toBe("fair");
    expect(rateQuality({ rttMs: 80, lossPct: 3, inKbps: 1, outKbps: 1 })).toBe("fair");
    expect(rateQuality({ rttMs: 600, lossPct: 0, inKbps: 1, outKbps: 1 })).toBe("poor");
    expect(rateQuality({ rttMs: 80, lossPct: 12, inKbps: 1, outKbps: 1 })).toBe("poor");
  });

  it("steps video down at once and up only after a good period", () => {
    const last = VIDEO_STEPS.length - 1;
    expect(nextVideoStep(0, "poor", 0)).toBe(1);
    expect(nextVideoStep(last, "poor", 0)).toBe(last);
    expect(nextVideoStep(2, "good", STEP_UP_AFTER_MS - 1)).toBe(2);
    expect(nextVideoStep(2, "good", STEP_UP_AFTER_MS)).toBe(1);
    expect(nextVideoStep(0, "good", 1e9)).toBe(0);
    expect(nextVideoStep(1, "fair", 1e9)).toBe(1);
  });

  it("summarizes a stats report against the previous sample", () => {
    const rep = (bytesIn: number, packets: number, lost: number, bytesOut: number) => [
      { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.12 },
      { type: "candidate-pair", nominated: false, state: "waiting", currentRoundTripTime: 9 },
      { type: "inbound-rtp", bytesReceived: bytesIn, packetsReceived: packets, packetsLost: lost },
      { type: "outbound-rtp", bytesSent: bytesOut },
    ];
    const first = summarizeStats(rep(1000, 100, 0, 2000), null, 0);
    expect(first.stats).toEqual({ rttMs: 120, lossPct: null, inKbps: null, outKbps: null });
    const second = summarizeStats(rep(1000 + 250_000, 190, 10, 2000 + 500_000), first.sample, 2000);
    expect(second.stats.rttMs).toBe(120);
    expect(second.stats.lossPct).toBe(10); // 10 lost of 100 sent in the interval
    expect(second.stats.inKbps).toBe(1000); // 250 kB in 2 s
    expect(second.stats.outKbps).toBe(2000);
  });
});

/** A peer connection with real senders (replaceTrack / parameters) and events. */
class Pc extends EventTarget {
  signalingState = "stable";
  connectionState = "connected";
  iceConnectionState = "connected";
  localDescription: { sdp: string; type: string } | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((ev: unknown) => void) | null = null;
  restarts = 0;
  senders: Sender[] = [];
  report: object[] = [];
  addTrack(track: MediaStreamTrack) {
    const s = new Sender(track);
    this.senders.push(s);
    return s;
  }
  getSenders() {
    return this.senders as unknown as RTCRtpSender[];
  }
  removeTrack() {}
  restartIce() {
    this.restarts++;
    this.onnegotiationneeded?.();
  }
  async setLocalDescription() {
    this.signalingState = "have-local-offer";
    this.localDescription = { type: "offer", sdp: "v=0" };
  }
  async setRemoteDescription() {}
  async getStats() {
    const list = this.report;
    return { values: () => list[Symbol.iterator]() } as unknown as RTCStatsReport;
  }
}
class Sender {
  params: { encodings: Array<Record<string, number>> } = { encodings: [{}] };
  constructor(public track: MediaStreamTrack | null) {}
  async replaceTrack(t: MediaStreamTrack | null) {
    this.track = t;
  }
  getParameters() {
    return structuredClone(this.params);
  }
  async setParameters(p: { encodings: Array<Record<string, number>> }) {
    this.params = p;
  }
}
function track(kind: "audio" | "video", label = kind) {
  return { kind, label, enabled: true, readyState: "live", onended: null as null | (() => void), stop() { this.readyState = "ended"; } } as unknown as MediaStreamTrack & { label: string };
}
function stream(...tracks: MediaStreamTrack[]) {
  const list = [...tracks];
  return {
    getTracks: () => list,
    getAudioTracks: () => list.filter((t) => t.kind === "audio"),
    getVideoTracks: () => list.filter((t) => t.kind === "video"),
    removeTrack: (t: MediaStreamTrack) => void list.splice(list.indexOf(t), 1),
    addTrack: (t: MediaStreamTrack) => void list.push(t),
  } as unknown as MediaStream;
}

async function activeVideoCall(extra: Partial<ConstructorParameters<typeof CallController>[0]> = {}) {
  const pc = new Pc();
  const sent: CallSignal[] = [];
  let now = 0;
  const ctl = new CallController({
    pc: pc as unknown as RTCPeerConnection,
    acquire: async () => stream(track("audio"), track("video", "front")),
    send: async (s) => void sent.push(s),
    onChange: () => undefined,
    acquireVideo: async (facing) => track("video", facing),
    acquireScreen: async () => track("video", "screen"),
    now: () => now,
    ...extra,
  });
  await ctl.handle({ t: "invite", kind: "video" });
  await ctl.accept();
  pc.ontrack?.({ track: track("audio"), streams: [] });
  expect(ctl.state.phase).toBe("active");
  return { pc, ctl, sent, setNow: (t: number) => (now = t) };
}

class TestStream {
  private list: MediaStreamTrack[] = [];
  getTracks() {
    return this.list;
  }
  addTrack(t: MediaStreamTrack) {
    this.list.push(t);
  }
  removeTrack(t: MediaStreamTrack) {
    this.list = this.list.filter((x) => x !== t);
  }
}

describe("call controller: camera, screen, quality, handover (Н6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaStream", TestStream);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("switches front ↔ back camera without renegotiating", async () => {
    const { pc, ctl } = await activeVideoCall();
    const before = pc.senders.find((s) => s.track?.kind === "video")!;
    await ctl.switchCamera();
    expect(ctl.state.facing).toBe("environment");
    expect((before.track as unknown as { label: string }).label).toBe("environment");
    expect(ctl.state.local!.getVideoTracks().map((t) => (t as unknown as { label: string }).label)).toEqual(["environment"]);
    expect(pc.signalingState).toBe("stable");
    await ctl.switchCamera();
    expect(ctl.state.facing).toBe("user");
  });

  it("shares the screen and goes back to the camera when sharing stops", async () => {
    const { pc, ctl } = await activeVideoCall();
    const sender = pc.senders.find((s) => s.track?.kind === "video")!;
    const camera = sender.track;
    await ctl.toggleScreenShare();
    expect(ctl.state.sharing).toBe(true);
    expect((sender.track as unknown as { label: string }).label).toBe("screen");
    expect(ctl.canSwitchCamera).toBe(false);
    // The browser's own "Stop sharing" button ends the screen track.
    (sender.track as unknown as { onended: () => void }).onended();
    await vi.waitFor(() => expect(ctl.state.sharing).toBe(false));
    expect(sender.track).toBe(camera);
  });

  it("a poor link lowers the outgoing video one step; a good one raises it after a while", async () => {
    const { pc, ctl, setNow } = await activeVideoCall();
    const sender = pc.senders.find((s) => s.track?.kind === "video")!;
    const pair = (rtt: number) => ({ type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: rtt });
    pc.report = [pair(0.9)];
    setNow(1000);
    await ctl.sampleStats();
    expect(ctl.state.quality).toBe("poor");
    expect(ctl.videoQualityStep).toBe(1);
    expect(sender.params.encodings[0]).toEqual({ maxBitrate: VIDEO_STEPS[1].maxBitrate, scaleResolutionDownBy: 2 });
    pc.report = [pair(0.05)];
    setNow(2000);
    await ctl.sampleStats();
    expect(ctl.videoQualityStep).toBe(1);
    setNow(2000 + STEP_UP_AFTER_MS);
    await ctl.sampleStats();
    expect(ctl.videoQualityStep).toBe(0);
  });

  it("restarts ICE after a short disconnect, at most once per gap, and on a network change", async () => {
    const net = new EventTarget();
    const { pc, ctl, sent, setNow } = await activeVideoCall({ network: [net] });
    pc.iceConnectionState = "disconnected";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    await vi.advanceTimersByTimeAsync(DISCONNECTED_GRACE_MS - 1);
    expect(pc.restarts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pc.restarts).toBe(1);
    expect(ctl.state.reconnecting).toBe(true);
    expect(sent.some((s) => s.t === "sdp")).toBe(true);
    net.dispatchEvent(new Event("change"));
    expect(pc.restarts).toBe(1); // too soon
    setNow(RESTART_MIN_GAP_MS + 1);
    net.dispatchEvent(new Event("online"));
    expect(pc.restarts).toBe(2);
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    expect(ctl.state.reconnecting).toBe(false);
    ctl.dispose();
    setNow(1e9);
    net.dispatchEvent(new Event("change"));
    expect(pc.restarts).toBe(2);
  });

  it("an ICE restart offer that cannot leave does not end the call", async () => {
    let up = true;
    const { pc, ctl } = await activeVideoCall({
      send: async () => {
        if (!up) throw new Error("closed");
      },
    });
    up = false;
    expect(ctl.restartIce("network")).toBe(true);
    await vi.waitFor(() => expect(pc.restarts).toBe(1));
    await Promise.resolve();
    expect(ctl.state.phase).toBe("active");
  });
});
