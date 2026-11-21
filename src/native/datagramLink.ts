/**
 * П4 (experiment): a reliable, ordered, encrypted message channel over plain UDP datagrams, for
 * the native transport (src/native/punch.ts gives the socket). It offers what the app uses of
 * a WebRTC data channel: text and binary messages in order, back-pressure, close.
 *
 * WebRTC encrypts its channel with DTLS. Raw UDP has nothing, so this layer encrypts every
 * datagram itself: ChaCha20-Poly1305 with a key per direction from the session secret (HKDF),
 * and a 64-bit packet number as the nonce that never repeats (retransmissions get a new
 * number). The packet number is checked against a sliding window, so a replayed or reordered
 * copy of an old datagram is dropped. The app's own end-to-end encryption (Double Ratchet) still
 * runs inside, exactly as over WebRTC; this layer only replaces what DTLS did.
 *
 * Reliability: every data frame has a sequence number; the receiver acknowledges with the
 * highest in-order number plus up to 32 numbers above it (selective acks); the sender resends
 * after a timeout that doubles up to 3 s, and gives up (closes) after ~25 s without progress.
 * Messages larger than a datagram are cut into fragments of ≤ 1,150 bytes.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const MAX_DATAGRAM = 1200;
const WIRE_MAGIC = 0x50; // "P"
const WIRE_VERSION = 1;
const WIRE_HEADER = 10; // magic, version, packet number (8)
const TAG = 16;
const FRAME_DATA = 1;
const FRAME_ACK = 2;
const FRAME_PING = 3;
const FRAME_PONG = 4;
const FRAME_CLOSE = 5;
const DATA_HEADER = 1 + 4 + 4 + 2 + 2 + 1; // type, seq, msgId, frag, count, kind
export const MAX_FRAGMENT = MAX_DATAGRAM - WIRE_HEADER - TAG - DATA_HEADER;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_IN_FLIGHT = 128;
const DRAIN_BELOW = 32;
const MAX_REORDER = 1024;
const REPLAY_WINDOW = 2048;
const MAX_SACK = 32;
const RTO_MIN_MS = 250;
const RTO_MAX_MS = 3000;
const GIVE_UP_MS = 25_000;
const KEEPALIVE_MS = 10_000;
const IDLE_CLOSE_MS = 35_000;

export interface DatagramTransport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): () => void;
  close(): void;
}

export class DatagramLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatagramLinkError";
  }
}

/** The two directions' keys. Side "A" made the invitation. */
export function linkKeys(secret: Uint8Array, side: "A" | "B"): { send: Uint8Array; recv: Uint8Array } {
  const key = (from: "A" | "B") => hkdf(sha256, secret, new TextEncoder().encode("p2p-native/link/v1"), new TextEncoder().encode(`key ${from}`), 32);
  return side === "A" ? { send: key("A"), recv: key("B") } : { send: key("B"), recv: key("A") };
}

function nonceFor(pn: bigint): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, pn);
  return n;
}

interface Pending {
  frame: Uint8Array;
  firstSent: number;
  lastSent: number;
  rto: number;
}

interface Inbound {
  msgId: number;
  kind: number;
  count: number;
  parts: Uint8Array[];
  got: number;
}

export interface DatagramLinkOptions {
  now?: () => number;
  /** Timer functions, replaceable in tests. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
}

export class DatagramLink {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;
  private readonly now: () => number;
  private readonly stopTimer: () => void;
  private readonly offTransport: () => void;

  private pn = 0n; // next packet number we send
  private replayTop = -1n; // highest packet number received
  private replaySeen = new Set<bigint>(); // numbers within the window below the top

  private nextSeq = 0;
  private nextMsgId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly outQueue: Uint8Array[] = []; // frames waiting for room in the window

  private expected = 0; // next seq to deliver
  private readonly reorder = new Map<number, Uint8Array>(); // seq → DATA frame body
  private inbound: Inbound | null = null;
  private ackDue = false;

  private lastHeard: number;
  private lastSent: number;
  private closed = false;
  private readonly messageHandlers = new Set<(text: string) => void>();
  private readonly binaryHandlers = new Set<(bytes: Uint8Array) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private drainWaiters: Array<() => void> = [];

  private readonly transport: DatagramTransport;

  constructor(transport: DatagramTransport, secret: Uint8Array, side: "A" | "B", options: DatagramLinkOptions = {}) {
    this.transport = transport;
    const keys = linkKeys(secret, side);
    this.sendKey = keys.send;
    this.recvKey = keys.recv;
    this.now = options.now ?? Date.now;
    this.lastHeard = this.now();
    this.lastSent = this.now();
    this.offTransport = transport.onMessage((b) => this.onDatagram(b));
    const si = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const ci = options.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
    const id = si(() => this.tick(), 50);
    this.stopTimer = () => ci(id);
  }

  isOpen(): boolean {
    return !this.closed;
  }

  send(text: string): void {
    this.enqueue(FRAME_DATA_TEXT, new TextEncoder().encode(text));
  }

  async sendBinary(bytes: Uint8Array): Promise<void> {
    this.enqueue(FRAME_DATA_BINARY, bytes);
    await this.waitForDrain();
  }

  onMessage(handler: (text: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onBinary(handler: (bytes: Uint8Array) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Resolves when few enough frames are unacknowledged (back-pressure for file transfers). */
  waitForDrain(): Promise<void> {
    if (this.closed) return Promise.reject(new DatagramLinkError("The link is closed."));
    if (this.pending.size + this.outQueue.length < DRAIN_BELOW) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    try {
      this.sendFrame(Uint8Array.of(FRAME_CLOSE));
    } catch {
      /* transport already gone */
    }
    this.shutdown(reason);
  }

  /** Bytes in flight or queued (like RTCDataChannel.bufferedAmount, roughly). */
  get bufferedFrames(): number {
    return this.pending.size + this.outQueue.length;
  }

  // ------------------------------------------------------------------ sending

  private enqueue(kind: number, payload: Uint8Array): void {
    if (this.closed) throw new DatagramLinkError("The link is closed.");
    if (payload.length > MAX_MESSAGE_BYTES) throw new DatagramLinkError("Message too large.");
    const count = Math.max(1, Math.ceil(payload.length / MAX_FRAGMENT));
    const msgId = this.nextMsgId++ >>> 0;
    for (let i = 0; i < count; i++) {
      const part = payload.subarray(i * MAX_FRAGMENT, (i + 1) * MAX_FRAGMENT);
      const frame = new Uint8Array(DATA_HEADER + part.length);
      const v = new DataView(frame.buffer);
      frame[0] = FRAME_DATA;
      // seq is set when the frame enters the window
      v.setUint32(5, msgId);
      v.setUint16(9, i);
      v.setUint16(11, count);
      frame[13] = kind;
      frame.set(part, DATA_HEADER);
      this.outQueue.push(frame);
    }
    this.pump();
  }

  private pump(): void {
    while (this.outQueue.length > 0 && this.pending.size < MAX_IN_FLIGHT && !this.closed) {
      const frame = this.outQueue.shift()!;
      const seq = this.nextSeq++ >>> 0;
      new DataView(frame.buffer).setUint32(1, seq);
      const t = this.now();
      this.pending.set(seq, { frame, firstSent: t, lastSent: t, rto: RTO_MIN_MS });
      this.sendFrame(frame);
    }
  }

  private sendFrame(frame: Uint8Array): void {
    const pn = this.pn++;
    const header = new Uint8Array(WIRE_HEADER);
    header[0] = WIRE_MAGIC;
    header[1] = WIRE_VERSION;
    new DataView(header.buffer).setBigUint64(2, pn);
    const ct = chacha20poly1305(this.sendKey, nonceFor(pn), header).encrypt(frame);
    const out = new Uint8Array(WIRE_HEADER + ct.length);
    out.set(header, 0);
    out.set(ct, WIRE_HEADER);
    this.lastSent = this.now();
    this.transport.send(out);
  }

  private sendAck(): void {
    this.ackDue = false;
    const above = [...this.reorder.keys()].sort((a, b) => a - b).slice(0, MAX_SACK);
    const frame = new Uint8Array(1 + 4 + 1 + above.length * 4);
    const v = new DataView(frame.buffer);
    frame[0] = FRAME_ACK;
    v.setUint32(1, this.expected >>> 0);
    frame[5] = above.length;
    above.forEach((s, i) => v.setUint32(6 + i * 4, s));
    this.sendFrame(frame);
  }

  // ------------------------------------------------------------------ receiving

  private onDatagram(bytes: Uint8Array): void {
    if (this.closed) return;
    if (bytes.length < WIRE_HEADER + TAG + 1 || bytes[0] !== WIRE_MAGIC || bytes[1] !== WIRE_VERSION) return;
    const header = bytes.subarray(0, WIRE_HEADER);
    const pn = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(2);
    if (!this.freshPacketNumber(pn)) return;
    let frame: Uint8Array;
    try {
      frame = chacha20poly1305(this.recvKey, nonceFor(pn), header).decrypt(bytes.subarray(WIRE_HEADER));
    } catch {
      return; // forged or damaged: not ours
    }
    this.markSeen(pn);
    this.lastHeard = this.now();
    try {
      this.onFrame(frame);
    } catch {
      // A malformed frame from a peer who has the key: end the link rather than guess.
      this.shutdown("malformed frame");
    }
  }

  private freshPacketNumber(pn: bigint): boolean {
    if (pn > this.replayTop) return true;
    if (this.replayTop - pn >= BigInt(REPLAY_WINDOW)) return false;
    return !this.replaySeen.has(pn);
  }

  private markSeen(pn: bigint): void {
    if (pn > this.replayTop) {
      this.replayTop = pn;
      // Forget numbers that fell out of the window.
      if (this.replaySeen.size > REPLAY_WINDOW) {
        for (const x of this.replaySeen) if (this.replayTop - x >= BigInt(REPLAY_WINDOW)) this.replaySeen.delete(x);
      }
    }
    this.replaySeen.add(pn);
  }

  private onFrame(frame: Uint8Array): void {
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    switch (frame[0]) {
      case FRAME_DATA: {
        if (frame.length < DATA_HEADER) throw new DatagramLinkError("short data frame");
        const seq = v.getUint32(1);
        this.ackDue = true;
        const ahead = (seq - this.expected) >>> 0;
        if (ahead >= 0x80000000) return; // already delivered: just ack again
        if (ahead >= MAX_REORDER) return; // too far ahead: the sender will resend
        this.reorder.set(seq, frame);
        while (this.reorder.has(this.expected)) {
          const f = this.reorder.get(this.expected)!;
          this.reorder.delete(this.expected);
          this.expected = (this.expected + 1) >>> 0;
          this.deliverFragment(f);
        }
        return;
      }
      case FRAME_ACK: {
        if (frame.length < 6) throw new DatagramLinkError("short ack");
        const cumulative = v.getUint32(1);
        const n = frame[5];
        if (frame.length < 6 + n * 4) throw new DatagramLinkError("short ack");
        // Everything before `cumulative` arrived (sequence numbers wrap at 2^32).
        for (const seq of [...this.pending.keys()]) {
          const behind = (cumulative - seq) >>> 0;
          if (behind !== 0 && behind <= 0x80000000) this.pending.delete(seq);
        }
        for (let i = 0; i < n; i++) this.pending.delete(v.getUint32(6 + i * 4));
        this.pump();
        this.releaseDrain();
        return;
      }
      case FRAME_PING:
        this.sendFrame(Uint8Array.of(FRAME_PONG));
        return;
      case FRAME_PONG:
        return;
      case FRAME_CLOSE:
        this.shutdown("closed by the other side");
        return;
      default:
        return; // a newer frame type: ignore
    }
  }

  private deliverFragment(frame: Uint8Array): void {
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const msgId = v.getUint32(5);
    const index = v.getUint16(9);
    const count = v.getUint16(11);
    const kind = frame[13];
    if (count === 0 || index >= count || (kind !== FRAME_DATA_TEXT && kind !== FRAME_DATA_BINARY)) throw new DatagramLinkError("bad fragment");
    if (count * MAX_FRAGMENT > MAX_MESSAGE_BYTES + MAX_FRAGMENT) throw new DatagramLinkError("message too large");
    // Fragments arrive in order (delivery is in sequence), so a message is contiguous.
    if (index === 0) this.inbound = { msgId, kind, count, parts: [], got: 0 };
    const m = this.inbound;
    if (!m || m.msgId !== msgId || m.got !== index || m.count !== count || m.kind !== kind) throw new DatagramLinkError("fragment out of order");
    m.parts.push(frame.slice(DATA_HEADER));
    m.got++;
    if (m.got < m.count) return;
    this.inbound = null;
    const total = m.parts.reduce((a, p) => a + p.length, 0);
    const payload = new Uint8Array(total);
    let o = 0;
    for (const p of m.parts) {
      payload.set(p, o);
      o += p.length;
    }
    if (m.kind === FRAME_DATA_TEXT) {
      const text = new TextDecoder().decode(payload);
      for (const h of this.messageHandlers) h(text);
    } else {
      for (const h of this.binaryHandlers) h(payload);
    }
  }

  // ------------------------------------------------------------------ timers

  private tick(): void {
    if (this.closed) return;
    const t = this.now();
    if (this.ackDue) this.sendAck();
    for (const [, p] of this.pending) {
      if (t - p.firstSent > GIVE_UP_MS) {
        this.shutdown("the other side stopped answering");
        return;
      }
      if (t - p.lastSent >= p.rto) {
        p.lastSent = t;
        p.rto = Math.min(RTO_MAX_MS, p.rto * 2);
        this.sendFrame(p.frame);
      }
    }
    if (t - this.lastHeard > IDLE_CLOSE_MS) {
      this.shutdown("the other side went quiet");
      return;
    }
    if (t - this.lastSent > KEEPALIVE_MS) this.sendFrame(Uint8Array.of(FRAME_PING));
  }

  private releaseDrain(): void {
    if (this.pending.size + this.outQueue.length >= DRAIN_BELOW) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.offTransport();
    this.transport.close();
    this.pending.clear();
    this.outQueue.length = 0;
    this.reorder.clear();
    for (const w of this.drainWaiters) w();
    this.drainWaiters = [];
    for (const h of this.closeHandlers) h(reason);
  }
}

const FRAME_DATA_TEXT = 0;
const FRAME_DATA_BINARY = 1;
