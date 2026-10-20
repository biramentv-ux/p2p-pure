/**
 * Call signalling. Carried INSIDE the encrypted chat channel (session.seal), so the
 * SDP, which reveals network addresses, is never sent in clear. Media itself goes
 * peer to peer with WebRTC's own DTLS-SRTP encryption.
 *
 * Plaintext format: CALL_MARK + JSON. The chat sanitizes user text (removes the
 * \u0001 frame mark), so a typed message can never look like a call signal.
 */
import { FRAME_MARK } from "../p2p/photo";

export const CALL_MARK = `${FRAME_MARK}C|`;
/** Upper bound for an SDP. A video offer with several codecs is a few kilobytes. */
export const MAX_SDP_CHARS = 64_000;

export type CallKind = "audio" | "video";

export type CallSignal =
  | { t: "invite"; kind: CallKind }
  | { t: "accept" }
  | { t: "decline" }
  | { t: "end" }
  | { t: "sdp"; type: "offer" | "answer"; sdp: string };

/**
 * The encrypted session takes at most 4000 characters per message. A video SDP with
 * all its candidates is larger, so a long signal is split into parts (same idea as
 * photo frames) and put back together by SignalAssembler on the other side.
 */
export const PART_CHARS = 3_000;
const MAX_PARTS = 64;

/** Returns the plaintext messages that carry one signal, in order. */
export function encodeSignal(signal: CallSignal): string[] {
  const json = JSON.stringify(signal);
  if (json.length <= PART_CHARS) return [CALL_MARK + json];
  const id = Math.random().toString(36).slice(2, 10);
  const n = Math.ceil(json.length / PART_CHARS);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = json.slice(i * PART_CHARS, (i + 1) * PART_CHARS);
    parts.push(CALL_MARK + JSON.stringify({ t: "part", id, i, n, d }));
  }
  return parts;
}

/** Reassembles split signals. Feed every call plaintext in arrival order. */
export class SignalAssembler {
  private id: string | null = null;
  private expected = 0;
  private next = 0;
  private chunks: string[] = [];

  /** Returns a complete signal, or null while parts are missing or the input is invalid. */
  feed(plaintext: string): CallSignal | null {
    if (!isCallSignal(plaintext)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(plaintext.slice(CALL_MARK.length));
    } catch {
      return null;
    }
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (o.t !== "part") return decodeSignal(plaintext);

    const { id, i, n, d } = o as { id?: unknown; i?: unknown; n?: unknown; d?: unknown };
    if (typeof id !== "string" || typeof d !== "string") return null;
    if (!Number.isInteger(i) || !Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_PARTS) return null;
    if (i === 0) {
      this.id = id;
      this.expected = n as number;
      this.next = 0;
      this.chunks = [];
    }
    if (id !== this.id || i !== this.next || n !== this.expected) {
      // A gap or a stray part: drop what we had, the sender will not retry.
      this.id = null;
      this.chunks = [];
      return null;
    }
    this.chunks.push(d);
    this.next++;
    if (this.next < this.expected) return null;
    const json = this.chunks.join("");
    this.id = null;
    this.chunks = [];
    return decodeSignal(CALL_MARK + json);
  }
}

export function isCallSignal(plaintext: string): boolean {
  return plaintext.startsWith(CALL_MARK);
}

/** Returns the signal, or null for anything that is not a well-formed call signal. */
export function decodeSignal(plaintext: string): CallSignal | null {
  if (!isCallSignal(plaintext)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.slice(CALL_MARK.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.t) {
    case "invite":
      return o.kind === "audio" || o.kind === "video" ? { t: "invite", kind: o.kind } : null;
    case "accept":
    case "decline":
    case "end":
      return { t: o.t };
    case "sdp": {
      const ok =
        (o.type === "offer" || o.type === "answer") &&
        typeof o.sdp === "string" &&
        o.sdp.startsWith("v=") &&
        o.sdp.length <= MAX_SDP_CHARS;
      return ok ? { t: "sdp", type: o.type as "offer" | "answer", sdp: o.sdp as string } : null;
    }
    default:
      return null;
  }
}
