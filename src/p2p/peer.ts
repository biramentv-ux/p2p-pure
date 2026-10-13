/**
 * WebRTC data-channel wrapper for a single peer-to-peer link.
 *
 * Signalling is done out-of-band by the user via QR codes, so we use
 * NON-TRICKLE ICE: we wait for gathering to finish and carry the complete
 * SDP (with all candidates) inside the invitation. Trickle would need a
 * signalling channel we don't have.
 *
 * Only public STUN is used (hard constraint). No TURN: some NATs will fail.
 */

export const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];
export const DATA_CHANNEL_LABEL = "p2pm";
const ICE_GATHER_TIMEOUT_MS = 8_000;
export const CONNECT_TIMEOUT_MS = 30_000;

export class PeerLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerLinkError";
  }
}

type MessageHandler = (text: string) => void;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private handlers = new Set<MessageHandler>();
  /** Messages that arrive before any handler is attached are kept, not dropped. */
  private pending: string[] = [];
  private openPromise: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (err: Error) => void;
  private closed = false;

  private constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // Avoid unhandled-rejection noise if nobody awaits waitForOpen().
    this.openPromise.catch(() => undefined);

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === "failed" || state === "closed") {
        this.rejectOpen(new PeerLinkError(`Connection ${state}. The network may block direct P2P.`));
      }
    };
  }

  /** Initiator side: creates the data channel and an offer with full ICE. */
  static async createOffer(): Promise<{ link: PeerLink; sdp: string }> {
    const link = new PeerLink();
    link.attachChannel(link.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    const sdp = await link.gatheredSdp();
    return { link, sdp };
  }

  /** Responder side: consumes an offer SDP and produces an answer with full ICE. */
  static async createAnswer(offerSdp: string): Promise<{ link: PeerLink; sdp: string }> {
    const link = new PeerLink();
    link.pc.ondatachannel = (ev) => link.attachChannel(ev.channel);
    await link.pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    const sdp = await link.gatheredSdp();
    return { link, sdp };
  }

  /** Initiator side: applies the responder's answer SDP. */
  async acceptAnswer(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  waitForOpen(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PeerLinkError("Timed out waiting for the data channel to open.")),
        timeoutMs,
      );
    });
    return Promise.race([this.openPromise, timeout]).finally(() => clearTimeout(timer));
  }

  isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

  send(text: string): void {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new PeerLinkError("Data channel is not open.");
    }
    this.channel.send(text);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    if (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const text of queued) handler(text);
    }
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectOpen(new PeerLinkError("Link closed."));
    this.channel?.close();
    this.pc.close();
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.resolveOpen();
    channel.onclose = () => this.rejectOpen(new PeerLinkError("Data channel closed."));
    channel.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      if (this.handlers.size === 0) {
        this.pending.push(ev.data);
        return;
      }
      for (const h of [...this.handlers]) h(ev.data);
    };
  }

  /** Resolves once ICE gathering completes (or times out) and returns the full local SDP. */
  private async gatheredSdp(): Promise<string> {
    if (this.pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (this.pc.iceGatheringState !== "complete") return;
          this.pc.removeEventListener("icegatheringstatechange", done);
          clearTimeout(timer);
          resolve();
        };
        this.pc.addEventListener("icegatheringstatechange", done);
        timer = setTimeout(() => {
          this.pc.removeEventListener("icegatheringstatechange", done);
          resolve(); // use whatever candidates we have
        }, ICE_GATHER_TIMEOUT_MS);
      });
    }
    const local = this.pc.localDescription;
    if (!local) throw new PeerLinkError("No local description after ICE gathering.");
    return local.sdp;
  }
}
