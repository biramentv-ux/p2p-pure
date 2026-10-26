import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallController, type CallDeps, type CallSnapshot } from "../../src/call/callController";
import type { CallSignal } from "../../src/call/signal";

/** Minimal stand-in for RTCPeerConnection: records what the controller does with it. */
class FakePeer {
  signalingState: "stable" | "have-local-offer" | "have-remote-offer" = "stable";
  connectionState = "new";
  localDescription: { sdp: string; type: string } | null = null;
  senders: Array<{ track: MediaStreamTrack | null }> = [];
  added: MediaStreamTrack[] = [];
  removed = 0;
  remoteSet: Array<{ type: string; sdp: string }> = [];
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((ev: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  localCount = 0;
  constructor(readonly log: string[] = []) {}

  addTrack(track: MediaStreamTrack) {
    this.log.push("track");
    this.added.push(track);
    this.senders.push({ track });
    return {} as RTCRtpSender;
  }
  getSenders() {
    return this.senders as unknown as RTCRtpSender[];
  }
  removeTrack(sender: RTCRtpSender) {
    this.removed++;
    (sender as unknown as { track: null }).track = null;
  }
  async setLocalDescription() {
    this.localCount++;
    this.signalingState = "have-local-offer";
    this.localDescription = { type: "offer", sdp: `v=0 local-${this.localCount}` };
  }
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteSet.push(desc);
    if (desc.type === "offer") this.signalingState = "have-remote-offer";
    else this.signalingState = "stable";
  }
}

function fakeTrack(kind: "audio" | "video") {
  const t = { kind, enabled: true, stopped: false, onended: null as null | (() => void), stop() { this.stopped = true; } };
  return t as unknown as MediaStreamTrack & { stopped: boolean };
}

function fakeStream(...kinds: Array<"audio" | "video">) {
  const tracks = kinds.map(fakeTrack);
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream & { tracks: Array<MediaStreamTrack & { stopped: boolean }> };
}

function setup(opts: { acquire?: CallDeps["acquire"]; ringTimeoutMs?: number } = {}) {
  const log: string[] = [];
  const pc = new FakePeer(log);
  const sent: CallSignal[] = [];
  const states: CallSnapshot[] = [];
  const acquire: CallDeps["acquire"] = opts.acquire ?? (async (kind) => fakeStream("audio", ...(kind === "video" ? (["video"] as const) : [])) as unknown as MediaStream);
  const ctl = new CallController({
    pc: pc as unknown as RTCPeerConnection,
    acquire,
    send: async (s) => {
      log.push(`send:${s.t}`);
      sent.push(s);
    },
    onChange: (s) => states.push(s),
    ringTimeoutMs: opts.ringTimeoutMs,
  });
  return { pc, sent, states, ctl, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("calling", () => {
  it("starts a call: acquires devices, sends an invite, waits for the answer", async () => {
    const { sent, ctl } = setup();
    await ctl.startCall("video");
    expect(ctl.state.phase).toBe("outgoing");
    expect(ctl.state.kind).toBe("video");
    expect(sent).toEqual([{ t: "invite", kind: "video" }]);
  });

  it("accepted by the peer: waits for the callee's offer, answers it, then adds our tracks", async () => {
    const { pc, sent, ctl, log } = setup();
    await ctl.startCall("audio");
    await ctl.handle({ t: "accept" });
    expect(ctl.state.phase).toBe("connecting");
    expect(pc.added.length).toBe(0); // the caller never offers first
    await ctl.handle({ t: "sdp", type: "offer", sdp: "v=0 callee-offer" });
    expect(sent.at(-1)).toMatchObject({ t: "sdp", type: "answer" });
    expect(pc.added.length).toBe(1); // audio, added after the answer
    expect(log.indexOf("send:sdp")).toBeLessThan(log.indexOf("track"));
    // The browser then fires negotiationneeded for our new tracks: we send our offer.
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ t: "sdp", type: "offer" }));
  });

  it("declined by the peer: ends with a message and releases devices", async () => {
    const { ctl, states } = setup();
    await ctl.startCall("audio");
    const local = ctl.state.local as unknown as { tracks: Array<{ stopped: boolean }> };
    await ctl.handle({ t: "decline" });
    expect(ctl.state.phase).toBe("ended");
    expect(ctl.state.error).toBe("Другият човек отказа.");
    expect(local.tracks[0].stopped).toBe(true);
    expect(states.length).toBeGreaterThan(1);
  });

  it("no answer within the ring timeout ends the call", async () => {
    const { sent, ctl } = setup({ ringTimeoutMs: 1_000 });
    await ctl.startCall("audio");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(ctl.state.phase).toBe("ended");
    expect(ctl.state.error).toBe("Няма отговор.");
    expect(sent.at(-1)).toEqual({ t: "end" });
  });

  it("refuses to start a second call while one is running", async () => {
    const { sent, ctl } = setup();
    await ctl.startCall("audio");
    await ctl.startCall("video");
    expect(sent.filter((s) => s.t === "invite")).toHaveLength(1);
  });

  it("denied microphone: the call does not start and the person is told why", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { sent, ctl } = setup({ acquire: async () => Promise.reject(denied) });
    await ctl.startCall("audio");
    expect(ctl.state.phase).toBe("ended");
    expect(ctl.state.error).toBe("Нямаш разрешение за микрофона или камерата.");
    expect(sent).toEqual([]);
  });
});

describe("receiving", () => {
  it("shows an incoming call; accept sends accept BEFORE adding tracks, and the callee offers first", async () => {
    const { pc, sent, ctl, log } = setup();
    await ctl.handle({ t: "invite", kind: "video" });
    expect(ctl.state.phase).toBe("incoming");
    await ctl.accept();
    expect(sent[0]).toEqual({ t: "accept" });
    // A video call adds the microphone and the camera track.
    expect(pc.added.length).toBe(2);
    expect(log.indexOf("send:accept")).toBeLessThan(log.indexOf("track"));
    pc.onnegotiationneeded?.();
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ t: "sdp", type: "offer" }));
  });

  it("decline sends decline and returns to idle", async () => {
    const { sent, ctl } = setup();
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.decline();
    expect(sent).toEqual([{ t: "decline" }]);
    expect(ctl.state.phase).toBe("idle");
  });

  it("a second invite while busy is declined automatically", async () => {
    const { sent, ctl } = setup();
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.handle({ t: "invite", kind: "video" });
    expect(sent).toEqual([{ t: "decline" }]);
    expect(ctl.state.kind).toBe("audio");
  });

  it("the other side hanging up ends our call", async () => {
    const { ctl } = setup();
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.accept();
    await ctl.handle({ t: "end" });
    expect(ctl.state.phase).toBe("ended");
    expect(ctl.state.error).toBe("Другият човек затвори разговора.");
  });

  it("an answer that does not match our offer is ignored", async () => {
    const { pc, ctl } = setup();
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.handle({ t: "sdp", type: "answer", sdp: "v=0 stray" });
    expect(pc.remoteSet).toHaveLength(0);
  });
});

describe("in call", () => {
  it("mute and camera toggles change track.enabled without renegotiating", async () => {
    const { pc, ctl } = setup({
      acquire: async () => fakeStream("audio", "video") as unknown as MediaStream,
    });
    await ctl.startCall("video");
    await ctl.handle({ t: "accept" });
    const before = pc.localCount;
    ctl.setMuted(true);
    ctl.setCameraOff(true);
    const [a, v] = (ctl.state.local as unknown as { tracks: Array<{ enabled: boolean }> }).tracks;
    expect(a.enabled).toBe(false);
    expect(v.enabled).toBe(false);
    expect(ctl.state.muted).toBe(true);
    expect(ctl.state.cameraOff).toBe(true);
    expect(pc.localCount).toBe(before);
  });

  it("hangup sends end, stops our tracks and removes our senders", async () => {
    const { pc, sent, ctl } = setup();
    await ctl.startCall("audio");
    await ctl.handle({ t: "accept" });
    await ctl.handle({ t: "sdp", type: "offer", sdp: "v=0 callee-offer" });
    const local = ctl.state.local as unknown as { tracks: Array<{ stopped: boolean }> };
    await ctl.hangup();
    expect(sent.at(-1)).toEqual({ t: "end" });
    expect(local.tracks[0].stopped).toBe(true);
    expect(pc.removed).toBeGreaterThan(0);
    expect(ctl.state.phase).toBe("ended");
  });

  it("a peer offer while we are not offering is answered", async () => {
    const { pc, sent, ctl } = setup();
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.accept();
    await ctl.handle({ t: "sdp", type: "offer", sdp: "v=0 remote-offer" });
    expect(pc.remoteSet.at(-1)).toEqual({ type: "offer", sdp: "v=0 remote-offer" });
    expect(sent.at(-1)).toMatchObject({ t: "sdp", type: "answer" });
  });

  it("dispose stops the tracks and detaches the connection handlers", async () => {
    const { pc, ctl } = setup();
    await ctl.startCall("audio");
    const local = ctl.state.local as unknown as { tracks: Array<{ stopped: boolean }> };
    ctl.dispose();
    expect(local.tracks[0].stopped).toBe(true);
    expect(pc.onnegotiationneeded).toBeNull();
    expect(pc.ontrack).toBeNull();
  });
});

describe("active phase", () => {
  /** jsdom has no MediaStream; a minimal one that keeps its tracks is enough here. */
  class TestStream {
    private tracks: MediaStreamTrack[] = [];
    addTrack(t: MediaStreamTrack) {
      this.tracks.push(t);
    }
    removeTrack(t: MediaStreamTrack) {
      this.tracks = this.tracks.filter((x) => x !== t);
    }
    getTracks() {
      return [...this.tracks];
    }
  }
  beforeEach(() => vi.stubGlobal("MediaStream", TestStream));
  afterEach(() => vi.unstubAllGlobals());

  const remoteTrack = () => ({ kind: "audio", onended: null }) as unknown as MediaStreamTrack;

  it("on a connection that is already up (shared with the chat), the first remote track makes it active", async () => {
    const { pc, ctl } = setup();
    pc.connectionState = "connected";
    await ctl.handle({ t: "invite", kind: "audio" });
    await ctl.accept();
    expect(ctl.state.phase).toBe("connecting");
    pc.ontrack?.({ track: remoteTrack(), streams: [] });
    expect(ctl.state.phase).toBe("active");
  });

  it("on a fresh connection, it waits for both the track and the connected state", async () => {
    const { pc, ctl } = setup();
    await ctl.startCall("audio");
    await ctl.handle({ t: "accept" });
    pc.ontrack?.({ track: remoteTrack(), streams: [] });
    expect(ctl.state.phase).toBe("connecting");
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    expect(ctl.state.phase).toBe("active");
  });

  it("connected without any remote media stays connecting", async () => {
    const { pc, ctl } = setup();
    await ctl.startCall("audio");
    await ctl.handle({ t: "accept" });
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    expect(ctl.state.phase).toBe("connecting");
  });
});
