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
}

export interface CallDeps {
  pc: RTCPeerConnection;
  /** Asks the device for a microphone (and camera for video). May reject. */
  acquire: (kind: CallKind) => Promise<MediaStream>;
  /** Sends a signal through the encrypted chat channel. */
  send: (signal: CallSignal) => Promise<void>;
  onChange: (snapshot: CallSnapshot) => void;
  ringTimeoutMs?: number;
}

const EMPTY: CallSnapshot = {
  phase: "idle",
  kind: null,
  local: null,
  remote: null,
  muted: false,
  cameraOff: false,
  error: null,
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

  /** Handlers are kept so dispose() only clears the ones it installed. */
  private readonly onNegotiation = () => void this.negotiate();
  private readonly onTrack = (ev: RTCTrackEvent) => this.handleTrack(ev);
  private readonly onConnection = () => this.handleConnectionState();

  constructor(deps: CallDeps) {
    this.deps = deps;
    const pc = deps.pc;
    pc.onnegotiationneeded = this.onNegotiation;
    pc.ontrack = this.onTrack;
    pc.onconnectionstatechange = this.onConnection;
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
  }

  private handleConnectionState(): void {
    if (this.disposed) return;
    const state = this.deps.pc.connectionState;
    if (state === "connected") this.maybeActive();
    if (state === "failed") this.fail("Връзката за разговора не можа да се установи.");
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
    stopAll(this.snap.local);
    const pc = this.deps.pc;
    if (pc.onnegotiationneeded === this.onNegotiation) pc.onnegotiationneeded = null;
    if (pc.ontrack === this.onTrack) pc.ontrack = null;
    if (pc.onconnectionstatechange === this.onConnection) pc.onconnectionstatechange = null;
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
      const desc = pc.localDescription;
      if (desc) await this.deps.send({ t: "sdp", type: "offer", sdp: desc.sdp });
    } catch (err) {
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
