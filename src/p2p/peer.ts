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

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  // A second public STUN server (no data passes through it). Helps reflexive candidates on IPv6 networks.
];
/** Pause sending while this many bytes wait in the browser's buffer (photos are many frames). */
const SEND_BUFFER_HIGH = 512 * 1024;
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
type BinaryHandler = (bytes: Uint8Array) => void;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private handlers = new Set<MessageHandler>();
  /** Binary messages carry file chunks (p2p/fileTransfer.ts); they are already encrypted. */
  private binaryHandlers = new Set<BinaryHandler>();
  /** Messages that arrive before any handler is attached are kept, not dropped. */
  private pending: string[] = [];
  private openPromise: Promise<void>;
  private resolveOpen!: () => void;
  private rejectOpen!: (err: Error) => void;
  private closed = false;
  /** Notified once when the link stops working after (or before) it opened. */
  private closeHandlers = new Set<(reason: string) => void>();
  private closeReason: string | null = null;

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
        this.notifyClose(`connection ${state}`);
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

  /** Sends a binary message (an encrypted file chunk), then waits until the buffer drains. */
  async sendBinary(bytes: Uint8Array): Promise<void> {
    if (!this.channel || this.channel.readyState !== "open") {
      throw new PeerLinkError("Data channel is not open.");
    }
    this.channel.send(bytes as Uint8Array<ArrayBuffer>);
    await this.waitForDrain();
  }

  onBinary(handler: BinaryHandler): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  /** Resolves when the outgoing buffer has drained enough to send more. */
  async waitForDrain(): Promise<void> {
    const ch = this.channel;
    if (!ch || ch.bufferedAmount < SEND_BUFFER_HIGH) return;
    await new Promise<void>((resolve) => {
      ch.bufferedAmountLowThreshold = SEND_BUFFER_HIGH / 4;
      const done = () => {
        ch.removeEventListener("bufferedamountlow", done);
        ch.removeEventListener("close", done);
        resolve();
      };
      ch.addEventListener("bufferedamountlow", done);
      ch.addEventListener("close", done);
    });
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

  /**
   * Called once when the data channel closes or the connection fails, also after it opened
   * (waitForOpen only covers the time before). Fires at once if that already happened.
   */
  onClose(handler: (reason: string) => void): () => void {
    if (this.closeReason !== null) {
      handler(this.closeReason);
      return () => undefined;
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private notifyClose(reason: string): void {
    if (this.closeReason !== null) return;
    this.closeReason = reason;
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const h of handlers) h(reason);
  }

  close(): void {
    this.notifyClose("closed locally");
    if (this.closed) return;
    this.closed = true;
    this.rejectOpen(new PeerLinkError("Link closed."));
    this.channel?.close();
    this.pc.close();
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.resolveOpen();
    channel.onclose = () => {
      this.rejectOpen(new PeerLinkError("Data channel closed."));
      this.notifyClose("data channel closed");
    };
    channel.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(ev.data);
        for (const h of [...this.binaryHandlers]) h(bytes);
        return;
      }
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
