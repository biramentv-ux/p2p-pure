/**
 * П6 (experiment): a Tor stream as PeerLink's second way to open (the same DatagramChannel
 * slot the native transport uses). Tor gives a reliable, ordered byte stream between two onion
 * services, so this is only framing and a proof of membership:
 *
 *   frame = length (u32 BE, type + payload) | type (u8) | payload
 *   type 0 text, 1 binary, 2 hello
 *
 * Hello: the initiator (A) sends HMAC(k, "A"), the responder (B) answers HMAC(k, "B"), k derived
 * from the two ephemeral keys of the signed invitations and the offer nonce. Anyone can open a
 * stream to an onion address; only the person this pairing was made with can say hello. Until
 * then nothing else is accepted. The identity handshake and the Double Ratchet run on top.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { nativeSecret } from "../native/endpoint";
import type { DatagramChannel } from "../p2p/peer";
import type { TorBridge } from "./torBridge";

const MAX_FRAME = 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class TorChannelError extends Error {}

export function torKey(myEphemeralSecret: Uint8Array, peerEphemeralPublic: Uint8Array, offerNonce: Uint8Array): Uint8Array {
  return hkdf(sha256, nativeSecret(myEphemeralSecret, peerEphemeralPublic, offerNonce), undefined, enc.encode("p2p-tor/hello/v1"), 32);
}

export function helloTag(key: Uint8Array, side: "A" | "B"): Uint8Array {
  return hmac(sha256, key, enc.encode(side));
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 1 > MAX_FRAME) throw new TorChannelError("frame too large");
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

/** Splits a byte stream into frames. A length above the limit ends the stream (throws). */
export class FrameSplitter {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Array<{ type: number; payload: Uint8Array }> {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    const out: Array<{ type: number; payload: Uint8Array }> = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const len = new DataView(joined.buffer, joined.byteOffset + at).getUint32(0, false);
      if (len < 1 || len > MAX_FRAME) throw new TorChannelError("bad frame length");
      if (joined.length - at - 4 < len) break;
      out.push({ type: joined[at + 4], payload: joined.slice(at + 5, at + 4 + len) });
      at += 4 + len;
    }
    this.buf = joined.slice(at);
    return out;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** One proven stream as a DatagramChannel. */
class TorStreamChannel implements DatagramChannel {
  private open = true;
  private textHandlers = new Set<(t: string) => void>();
  private binHandlers = new Set<(b: Uint8Array) => void>();
  private closeHandlers = new Set<(r: string) => void>();
  private queue: Promise<void> = Promise.resolve();
  private readonly bridge: TorBridge;
  private readonly id: number;

  constructor(bridge: TorBridge, id: number) {
    this.bridge = bridge;
    this.id = id;
  }

  deliver(type: number, payload: Uint8Array): void {
    if (type === 0) for (const h of this.textHandlers) h(dec.decode(payload));
    else if (type === 1) for (const h of this.binHandlers) h(payload);
  }

  ended(reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const h of this.closeHandlers) h(reason);
  }

  isOpen(): boolean {
    return this.open;
  }
  private write(frame: Uint8Array): Promise<void> {
    this.queue = this.queue.then(() => this.bridge.send(this.id, frame)).catch(() => this.ended("tor send failed"));
    return this.queue;
  }
  send(text: string): void {
    if (this.open) void this.write(encodeFrame(0, enc.encode(text)));
  }
  sendBinary(bytes: Uint8Array): Promise<void> {
    return this.open ? this.write(encodeFrame(1, bytes)) : Promise.resolve();
  }
  waitForDrain(): Promise<void> {
    return this.queue;
  }
  onMessage(h: (text: string) => void): () => void {
    this.textHandlers.add(h);
    return () => this.textHandlers.delete(h);
  }
  onBinary(h: (bytes: Uint8Array) => void): () => void {
    this.binHandlers.add(h);
    return () => this.binHandlers.delete(h);
  }
  onClose(h: (reason: string) => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
  }
  bufferedFrames(): number {
    return 0;
  }
  close(): void {
    this.bridge.close(this.id);
    this.ended("closed");
  }
}

/**
 * Opens the channel. A: connects to the peer's onion (retrying while its descriptor is still
 * being published) and says hello first. B: waits for an incoming stream that says the right
 * hello; streams that do not, within 20 s, are closed.
 */
export function openTorChannel(args: { bridge: TorBridge; side: "A" | "B"; key: Uint8Array; peerOnion: string; timeoutMs: number; signal: { cancelled: boolean } }): Promise<DatagramChannel> {
  const { bridge, side, key } = args;
  const mine = helloTag(key, side);
  const theirs = helloTag(key, side === "A" ? "B" : "A");
  return new Promise<DatagramChannel>((resolve, reject) => {
    const streams = new Map<number, { split: FrameSplitter; proven: TorStreamChannel | null; timer?: ReturnType<typeof setTimeout> }>();
    let done = false;
    const finish = (err: Error | null, ch?: TorStreamChannel) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (err) {
        off();
        for (const id of streams.keys()) bridge.close(id);
        reject(err);
      } else resolve(ch as TorStreamChannel);
    };
    const deadline = setTimeout(() => finish(new TorChannelError("tor timeout")), args.timeoutMs);
    const off = bridge.onEvent((e) => {
      if (e.kind === "open") {
        if (side === "A" || !e.incoming || done) return;
        const timer = setTimeout(() => {
          bridge.close(e.id);
          streams.delete(e.id);
        }, 20_000);
        streams.set(e.id, { split: new FrameSplitter(), proven: null, timer });
        return;
      }
      const s = streams.get(e.id);
      if (!s) return;
      if (e.kind === "close") {
        streams.delete(e.id);
        s.proven?.ended("tor stream closed");
        return;
      }
      let frames: Array<{ type: number; payload: Uint8Array }>;
      try {
        frames = s.split.push(e.data ?? new Uint8Array(0));
      } catch {
        bridge.close(e.id);
        streams.delete(e.id);
        return;
      }
      for (const f of frames) {
        if (s.proven) {
          s.proven.deliver(f.type, f.payload);
          continue;
        }
        if (f.type !== 2 || !equal(f.payload, theirs) || done) {
          bridge.close(e.id);
          streams.delete(e.id);
          return;
        }
        clearTimeout(s.timer);
        s.proven = new TorStreamChannel(bridge, e.id);
        if (side === "B") void bridge.send(e.id, encodeFrame(2, mine)).catch(() => undefined);
        finish(null, s.proven);
      }
    });
    if (side === "A") {
      void (async () => {
        while (!done && !args.signal.cancelled) {
          try {
            const id = await bridge.connect(args.peerOnion);
            streams.set(id, { split: new FrameSplitter(), proven: null });
            await bridge.send(id, encodeFrame(2, mine));
            return;
          } catch {
            // The peer's onion descriptor may not be published yet: try again shortly.
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        if (args.signal.cancelled) finish(new TorChannelError("cancelled"));
      })();
    }
  });
}
