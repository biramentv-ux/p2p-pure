/**
 * Audio and video call state machine for one chat (one RTCPeerConnection).
 *
 * Media is added to the SAME peer connection that carries the chat data channel, so
 * no second connection is needed. Adding or removing tracks renegotiates the
 * connection; that is done with the "perfect negotiation" pattern, so when both sides
 * renegotiate at once, one side yields instead of the two offers colliding.
 *
 * Order of negotiation (kept deliberately simple, so two offers never race):
 *   1. The callee accepts and adds its tracks: it sends the first offer.
 *   2. The caller answers that offer, and only then adds its own tracks, which makes
 *      the caller send the second offer. At any moment only one side is offering.
 * Perfect negotiation is still used for the rare case where both sides change tracks
 * at once (ending a call). Dependencies are injected so the logic can be tested
 * without a browser.
 */
import type { CallKind, CallSignal } from "./signal";
import { STATS_MS, VIDEO_STEPS, nextVideoStep, rateQuality, summarizeStats, type CallStats, type Quality, type StatsSample } from "./quality";

/** Wait this long in ICE "disconnected" before restarting ICE (it often recovers alone). */
export const DISCONNECTED_GRACE_MS = 2000;
/** At most one ICE restart in this window. */
export const RESTART_MIN_GAP_MS = 5000;

export const RING_TIMEOUT_MS = 45_000;

export type CallPhase = "idle" | "outgoing" | "incoming" | "connecting" | "active" | "ended";

export interface CallSnapshot {
  phase: CallPhase;
  kind: CallKind | null;
  local: MediaStream | null;
  remote: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  /** Shown to the person; null when nothing is wrong. */
  error: string | null;
  /** Link quality during an active call (quality.ts). */
  quality: Quality;
  stats: CallStats | null;
  /** Which camera sends video. */
  facing: "user" | "environment";
  /** The screen is being shared instead of the camera. */
  sharing: boolean;
  /** The network changed and the connection is being moved (ICE restart). */
  reconnecting: boolean;
}

export interface CallDeps {
  pc: RTCPeerConnection;
  /** Asks the device for a microphone (and camera for video). May reject. */
  acquire: (kind: CallKind) => Promise<MediaStream>;
  /** Sends a signal through the encrypted chat channel. */
  send: (signal: CallSignal) => Promise<void>;
  onChange: (snapshot: CallSnapshot) => void;
  ringTimeoutMs?: number;
  /** A new camera track for the other camera (Н6). Without it, the camera cannot be switched. */
  acquireVideo?: (facing: "user" | "environment") => Promise<MediaStreamTrack>;
  /** A screen track (getDisplayMedia). Without it, the screen cannot be shared. */
  acquireScreen?: () => Promise<MediaStreamTrack>;
  /**
   * Politeness for an ICE restart outside a call (perfect negotiation needs exactly one
   * polite side). The chat passes "responder of the session" (fixed for both sides).
   */
  polite?: boolean;
  /** Fires "online" or "change" when the device's network changes (window, navigator.connection). */
  network?: EventTarget[];
  now?: () => number;
}

const EMPTY: CallSnapshot = {
  phase: "idle",
  kind: null,
  local: null,
  remote: null,
  muted: false,
  cameraOff: false,
  error: null,
  quality: "unknown",
  stats: null,
  facing: "user",
  sharing: false,
  reconnecting: false,
};

export class CallController {
  private snap: CallSnapshot = { ...EMPTY };
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  /** Caller only: our tracks are added after we answer the callee's first offer. */
  private callerTracksPending = false;
  /** Negotiation only runs once a call has used media, so the first connection stays untouched. */
  private negotiationEnabled = false;
  private ringTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteStream: MediaStream | null = null;
  private disposed = false;
  private readonly deps: CallDeps;
  // Quality (Н6)
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private lastSample: StatsSample | null = null;
  private videoStep = 0;
  private goodSince: number | null = null;
  // Screen sharing: the camera track waits here while the screen is sent.
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  // Handover (ICE restart)
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRestart = -Infinity;
  private restarting = false;
  /** Bumped when a call ends: media opened for an earlier call is stopped, not used. */
  private callGen = 0;

  /** Handlers are kept so dispose() only clears the ones it installed. */
  private readonly onNegotiation = () => void this.negotiate();
  private readonly onTrack = (ev: RTCTrackEvent) => this.handleTrack(ev);
  private readonly onConnection = () => this.handleConnectionState();
  private readonly onIce = () => this.handleIceState();
  private readonly onNetwork = () => this.restartIce("network");

  constructor(deps: CallDeps) {
    this.deps = deps;
    const pc = deps.pc;
    pc.onnegotiationneeded = this.onNegotiation;
    pc.ontrack = this.onTrack;
    // Listeners, not on* properties: PeerLink owns pc.onconnectionstatechange (it reports a
    // dead link), and overwriting it here would hide that.
    pc.addEventListener("connectionstatechange", this.onConnection);
    pc.addEventListener("iceconnectionstatechange", this.onIce);
    for (const target of deps.network ?? []) {
      target.addEventListener("online", this.onNetwork);
      target.addEventListener("change", this.onNetwork);
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private handleTrack(ev: RTCTrackEvent): void {
    if (this.disposed) return;
    if (!this.remoteStream) this.remoteStream = new MediaStream();
    const stream = this.remoteStream;
    if (!stream.getTracks().includes(ev.track)) stream.addTrack(ev.track);
    ev.track.onended = () => this.removeRemoteTrack(ev.track);
    this.patch({ remote: stream });
    this.maybeActive();
  }

  /**
   * The call is active once the connection is up AND the other side's media has arrived.
   * The call shares the chat's RTCPeerConnection, which is usually "connected" already, so
   * connectionstatechange does not fire again; the first remote track is the real signal.
   */
  private maybeActive(): void {
    if (this.snap.phase !== "connecting") return;
    if (this.deps.pc.connectionState !== "connected") return;
    if (!this.remoteStream || this.remoteStream.getTracks().length === 0) return;
    this.patch({ phase: "active" });
    this.startStats();
  }

  private handleConnectionState(): void {
    if (this.disposed) return;
    const state = this.deps.pc.connectionState;
    if (state === "connected") {
      this.maybeActive();
      if (this.snap.reconnecting) this.patch({ reconnecting: false, error: null });
    }
    if (state === "failed") {
      // One ICE restart first: a network change can look like a failure.
      if (this.restartIce("failed")) return;
      if (this.snap.phase !== "idle" && this.snap.phase !== "ended") this.fail("Връзката за разговора не можа да се установи.");
    }
  }

  /* ---------- handover (Н6): keep the link across a network change ---------- */

  private handleIceState(): void {
    if (this.disposed) return;
    const ice = this.deps.pc.iceConnectionState;
    clearTimeout(this.disconnectTimer);
    if (ice === "disconnected") {
      this.disconnectTimer = setTimeout(() => {
        if (this.deps.pc.iceConnectionState === "disconnected") this.restartIce("disconnected");
      }, DISCONNECTED_GRACE_MS);
    } else if (ice === "connected" || ice === "completed") {
      this.restarting = false;
      if (this.snap.reconnecting) this.patch({ reconnecting: false });
    }
  }

  /**
   * Restarts ICE: new candidates from the network the device has now, offered over the
   * encrypted chat channel. Works while the old path still carries that offer (a handover);
   * when the old path is already gone, the offer cannot leave and the chat must reconnect.
   * Returns false when it did nothing (too soon after the last one, or closed).
   */
  restartIce(_why: "network" | "disconnected" | "failed"): boolean {
    const pc = this.deps.pc;
    if (this.disposed || pc.connectionState === "closed" || typeof pc.restartIce !== "function") return false;
    const now = this.now();
    if (now - this.lastRestart < RESTART_MIN_GAP_MS) return false;
    this.lastRestart = now;
    this.restarting = true;
    this.negotiationEnabled = true;
    // Outside a call nobody has set politeness yet; the chat's fixed role decides.
    if (this.snap.phase === "idle" || this.snap.phase === "ended") this.polite = this.deps.polite ?? false;
    if (this.snap.phase === "active" || this.snap.phase === "connecting") this.patch({ reconnecting: true });
    pc.restartIce();
    return true;
  }

  /* ---------- quality (Н6) ---------- */

  private startStats(): void {
    if (this.statsTimer !== undefined || typeof this.deps.pc.getStats !== "function") return;
    this.lastSample = null;
    this.videoStep = 0;
    this.goodSince = null;
    this.statsTimer = setInterval(() => void this.sampleStats(), STATS_MS);
  }

  private stopStats(): void {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.lastSample = null;
  }

  /** One stats round: rate the link and move the outgoing video one step if needed. */
  async sampleStats(): Promise<void> {
    if (this.disposed || this.snap.phase !== "active") return;
    let report: RTCStatsReport;
    try {
      report = await this.deps.pc.getStats();
    } catch {
      return;
    }
    const now = this.now();
    const { stats, sample } = summarizeStats(report.values() as Iterable<{ type: string }>, this.lastSample, now);
    this.lastSample = sample;
    const quality = rateQuality(stats);
    if (quality === "good") this.goodSince ??= now;
    else this.goodSince = null;
    this.patch({ stats, quality });
    if (this.snap.kind !== "video") return;
    const next = nextVideoStep(this.videoStep, quality, this.goodSince === null ? 0 : now - this.goodSince);
    if (next === this.videoStep) return;
    const stepUp = next < this.videoStep;
    this.videoStep = next;
    // After a step up, the next one waits a full good period again.
    if (stepUp) this.goodSince = now;
    await this.applyVideoStep();
  }

  private videoSender(): RTCRtpSender | null {
    return this.deps.pc.getSenders().find((s) => s.track?.kind === "video") ?? null;
  }

  private async applyVideoStep(): Promise<void> {
    const sender = this.videoSender();
    if (!sender || typeof sender.getParameters !== "function") return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    const step = VIDEO_STEPS[this.videoStep];
    params.encodings[0].maxBitrate = step.maxBitrate;
    // A shared screen keeps its resolution (text must stay readable); only the bitrate drops.
    params.encodings[0].scaleResolutionDownBy = this.snap.sharing ? 1 : step.scaleResolutionDownBy;
    try {
      await sender.setParameters(params);
    } catch {
      /* some browsers refuse while negotiating; the next round tries again */
    }
  }

  /** The step the outgoing video is at (0 = best). For tests and the screen. */
  get videoQualityStep(): number {
    return this.videoStep;
  }

  /* ---------- camera and screen (Н6) ---------- */

  /** True when the other camera can be used: a video call, a camera source, not sharing. */
  get canSwitchCamera(): boolean {
    return !!this.deps.acquireVideo && this.snap.kind === "video" && !this.snap.sharing && this.snap.phase === "active";
  }

  get canShareScreen(): boolean {
    return !!this.deps.acquireScreen && this.snap.kind === "video" && this.snap.phase === "active";
  }

  /** Front ↔ back camera, without renegotiation (replaceTrack). */
  async switchCamera(): Promise<void> {
    if (!this.canSwitchCamera || !this.deps.acquireVideo) return;
    const sender = this.videoSender();
    const local = this.snap.local;
    const old = local?.getVideoTracks()[0];
    if (!sender || !local || !old) return;
    const facing = this.snap.facing === "user" ? "environment" : "user";
    const gen = this.callGen;
    let track: MediaStreamTrack;
    try {
      track = await this.deps.acquireVideo(facing);
    } catch (err) {
      this.patch({ error: mediaMessage(err) });
      return;
    }
    // The call may have ended (or the chat closed) while the camera was opening.
    if (gen !== this.callGen || this.disposed || this.snap.phase !== "active" || this.snap.sharing) {
      track.stop();
      return;
    }
    track.enabled = !this.snap.cameraOff;
    try {
      await sender.replaceTrack(track);
    } catch {
      track.stop();
      return;
    }
    local.removeTrack(old);
    local.addTrack(track);
    old.stop();
    this.patch({ facing, local, error: null });
    await this.applyVideoStep();
  }

  /** Starts or stops sharing the screen instead of the camera. */
  async toggleScreenShare(): Promise<void> {
    if (this.snap.sharing) {
      await this.stopScreenShare();
      return;
    }
    if (!this.canShareScreen || !this.deps.acquireScreen) return;
    const sender = this.videoSender();
    if (!sender) return;
    const gen = this.callGen;
    let screen: MediaStreamTrack;
    try {
      screen = await this.deps.acquireScreen();
    } catch {
      return; // the person closed the picker
    }
    // The call may have ended (or the chat closed) while the picker was open: never leave a
    // screen capture running after it.
    if (gen !== this.callGen || this.disposed || this.snap.phase !== "active" || this.snap.sharing) {
      screen.stop();
      return;
    }
    const camera = sender.track;
    try {
      await sender.replaceTrack(screen);
    } catch {
      screen.stop();
      return;
    }
    if (gen !== this.callGen || this.disposed) {
      screen.stop();
      return;
    }
    this.cameraTrack = camera;
    this.screenTrack = screen;
    // The browser's own "Stop sharing" button ends the track: go back to the camera.
    screen.onended = () => void this.stopScreenShare();
    this.patch({ sharing: true });
    await this.applyVideoStep();
  }

  private async stopScreenShare(): Promise<void> {
    const screen = this.screenTrack;
    const camera = this.cameraTrack;
    this.screenTrack = null;
    this.cameraTrack = null;
    if (!screen) return;
    screen.onended = null;
    screen.stop();
    const sender = this.deps.pc.getSenders().find((s) => s.track === screen);
    if (sender && camera && camera.readyState !== "ended") await sender.replaceTrack(camera);
    this.patch({ sharing: false });
    await this.applyVideoStep();
  }

  get state(): CallSnapshot {
    return this.snap;
  }

  /** Starts an outgoing call. Only from an idle state. */
  async startCall(kind: CallKind): Promise<void> {
    if (this.snap.phase !== "idle" && this.snap.phase !== "ended") return;
    this.polite = false;
    let local: MediaStream;
    try {
      local = await this.deps.acquire(kind);
    } catch (err) {
      this.fail(mediaMessage(err));
      return;
    }
    this.patch({ phase: "outgoing", kind, local, remote: null, muted: false, cameraOff: false, error: null });
    await this.deps.send({ t: "invite", kind });
    this.ringTimer = setTimeout(() => {
      if (this.snap.phase === "outgoing") void this.hangup("Няма отговор.");
    }, this.deps.ringTimeoutMs ?? RING_TIMEOUT_MS);
  }

  /** Accepts an incoming call: sends accept first, then adds our tracks. */
  async accept(): Promise<void> {
    if (this.snap.phase !== "incoming" || !this.snap.kind) return;
    const kind = this.snap.kind;
    let local: MediaStream;
    try {
      local = await this.deps.acquire(kind);
    } catch (err) {
      await this.deps.send({ t: "decline" });
      this.fail(mediaMessage(err));
      return;
    }
    this.polite = true;
    this.patch({ phase: "connecting", local, error: null });
    await this.deps.send({ t: "accept" });
    this.addLocalTracks(local);
  }

  /** Declines an incoming call. */
  async decline(): Promise<void> {
    if (this.snap.phase !== "incoming") return;
    await this.deps.send({ t: "decline" });
    this.endLocal({ phase: "idle", kind: null });
  }

  /** Ends the call from either side. */
  async hangup(reason: string | null = null): Promise<void> {
    const phase = this.snap.phase;
    if (phase === "idle" || phase === "ended") return;
    clearTimeout(this.ringTimer);
    try {
      await this.deps.send({ t: "end" });
    } catch {
      /* the channel may already be gone; the local side still ends */
    }
    this.endLocal({ phase: "ended", kind: null, error: reason });
  }

  setMuted(muted: boolean): void {
    this.snap.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.patch({ muted });
  }

  setCameraOff(cameraOff: boolean): void {
    this.snap.local?.getVideoTracks().forEach((t) => (t.enabled = !cameraOff));
    this.patch({ cameraOff });
  }

  /** Handles a decrypted signal from the peer. */
  async handle(signal: CallSignal): Promise<void> {
    if (this.disposed) return;
    switch (signal.t) {
      case "invite": {
        const busy = this.snap.phase !== "idle" && this.snap.phase !== "ended";
        if (busy) {
          await this.deps.send({ t: "decline" });
          return;
        }
        this.patch({ phase: "incoming", kind: signal.kind, error: null, remote: null });
        return;
      }
      case "accept": {
        if (this.snap.phase !== "outgoing" || !this.snap.local) return;
        clearTimeout(this.ringTimer);
        this.polite = false;
        this.callerTracksPending = true;
        this.patch({ phase: "connecting" });
        return;
      }
      case "decline":
        if (this.snap.phase !== "outgoing") return;
        clearTimeout(this.ringTimer);
        this.endLocal({ phase: "ended", kind: null, error: "Другият човек отказа." });
        return;
      case "end":
        if (this.snap.phase === "idle" || this.snap.phase === "ended") return;
        clearTimeout(this.ringTimer);
        this.endLocal({ phase: "ended", kind: null, error: "Другият човек затвори разговора." });
        return;
      case "sdp":
        await this.onSdp(signal.type, signal.sdp);
        return;
    }
  }

  /** Stops everything. Called when the chat screen closes. */
  dispose(): void {
    if (this.disposed) return;
    clearTimeout(this.ringTimer);
    this.disposed = true;
    this.callGen++;
    this.stopStats();
    clearTimeout(this.disconnectTimer);
    this.screenTrack?.stop();
    stopAll(this.snap.local);
    const pc = this.deps.pc;
    if (pc.onnegotiationneeded === this.onNegotiation) pc.onnegotiationneeded = null;
    if (pc.ontrack === this.onTrack) pc.ontrack = null;
    pc.removeEventListener("connectionstatechange", this.onConnection);
    pc.removeEventListener("iceconnectionstatechange", this.onIce);
    for (const target of this.deps.network ?? []) {
      target.removeEventListener("online", this.onNetwork);
      target.removeEventListener("change", this.onNetwork);
    }
  }

  /* ---------- internals ---------- */

  private addLocalTracks(local: MediaStream): void {
    this.negotiationEnabled = true;
    const pc = this.deps.pc;
    for (const track of local.getTracks()) {
      pc.addTrack(track, local);
    }
  }

  private async negotiate(): Promise<void> {
    if (!this.negotiationEnabled || this.disposed) return;
    const pc = this.deps.pc;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      // After an ICE restart the new network's candidates are only in the description once
      // gathering is done (there is no trickle path): wait for it, briefly.
      await waitForGathering(pc);
      // While we waited, the polite side may have rolled our offer back for the other side's
      // offer and answered it: then there is no offer of ours left to send.
      const desc = pc.localDescription;
      if (!desc || desc.type !== "offer" || pc.signalingState !== "have-local-offer") return;
      await this.deps.send({ t: "sdp", type: "offer", sdp: desc.sdp });
    } catch (err) {
      // An ICE restart offer that cannot leave (the old path is already gone) is not a call
      // failure: the person sees "reconnecting" and the chat's link reports the drop.
      if (this.restarting) return;
      this.fail(err instanceof Error ? err.message : "Неуспешно договаряне на разговора.");
    } finally {
      this.makingOffer = false;
    }
  }

  private async onSdp(type: "offer" | "answer", sdp: string): Promise<void> {
    const pc = this.deps.pc;
    if (type === "answer") {
      // An answer is only valid for our pending offer.
      if (pc.signalingState !== "have-local-offer") return;
      this.settingRemoteAnswer = true;
      try {
        await pc.setRemoteDescription({ type, sdp });
      } finally {
        this.settingRemoteAnswer = false;
      }
      return;
    }
    const readyForOffer = !this.makingOffer && (pc.signalingState === "stable" || this.settingRemoteAnswer);
    const collision = !readyForOffer;
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    this.negotiationEnabled = true;
    await pc.setRemoteDescription({ type, sdp });
    await pc.setLocalDescription();
    await waitForGathering(pc);
    const desc = pc.localDescription;
    if (desc) await this.deps.send({ t: "sdp", type: "answer", sdp: desc.sdp });
    // Caller: the callee's offer is answered, so now our own tracks can be added.
    if (this.callerTracksPending && this.snap.local) {
      this.callerTracksPending = false;
      this.addLocalTracks(this.snap.local);
    }
  }

  private removeRemoteTrack(track: MediaStreamTrack): void {
    if (!this.remoteStream) return;
    this.remoteStream.removeTrack(track);
    if (this.remoteStream.getTracks().length === 0) this.remoteStream = null;
    this.patch({ remote: this.remoteStream });
  }

  /** Releases devices and tracks, removes our senders, and sets the new phase. */
  private endLocal(next: Partial<CallSnapshot> & { phase: CallPhase }): void {
    this.callGen++;
    this.stopStats();
    if (this.screenTrack) {
      this.screenTrack.onended = null;
      this.screenTrack.stop();
    }
    this.screenTrack = null;
    this.cameraTrack = null;
    stopAll(this.snap.local);
    const pc = this.deps.pc;
    for (const sender of pc.getSenders()) {
      if (sender.track) {
        try {
          pc.removeTrack(sender);
        } catch {
          /* already removed */
        }
      }
    }
    this.remoteStream = null;
    this.patch({
      ...EMPTY,
      error: next.error ?? null,
      phase: next.phase,
      kind: next.kind ?? null,
    });
  }

  private fail(message: string): void {
    clearTimeout(this.ringTimer);
    this.endLocal({ phase: "ended", kind: null, error: message });
  }

  private patch(part: Partial<CallSnapshot>): void {
    this.snap = { ...this.snap, ...part };
    this.deps.onChange(this.snap);
  }
}

function stopAll(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

function mediaMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Нямаш разрешение за микрофона или камерата.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Не намерих микрофон или камера.";
  }
  return "Не успях да включа микрофона или камерата.";
}

/** Longest wait for ICE gathering before an SDP goes out anyway (with what it has). */
export const GATHER_WAIT_MS = 3000;

/**
 * Resolves when ICE gathering is complete, or after GATHER_WAIT_MS. A renegotiation that
 * does not restart ICE has nothing new to gather and returns at once.
 */
export function waitForGathering(pc: Pick<RTCPeerConnection, "iceGatheringState"> & Partial<Pick<RTCPeerConnection, "addEventListener" | "removeEventListener">>, ms = GATHER_WAIT_MS): Promise<void> {
  if (!pc.iceGatheringState || pc.iceGatheringState === "complete" || !pc.addEventListener) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener?.("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener!("icegatheringstatechange", check);
  });
}
