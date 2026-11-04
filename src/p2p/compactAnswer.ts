/**
 * Compact signed answer (feature M7 "QR one way + sound back").
 *
 * The initiator shows its offer as a normal p2p1 QR code. The responder's answer travels back
 * by sound (about 12-15 bytes/s), so it must be tiny. The initiator already holds its own offer,
 * so the answer carries only what the initiator cannot know: the responder's identity and
 * ephemeral keys, its DTLS fingerprint, ICE credentials, DTLS role and a few candidates. The
 * initiator rebuilds a minimal data-channel answer SDP from these fields.
 *
 * Binary layout, version 1 (all integers big-endian):
 *   [0]        version (0x01)
 *   [1]        flags
 *                bit 0     DTLS setup role: 0 = active, 1 = passive
 *                bits 1-2  candidate count (0..3)
 *                bits 3-4  max-message-size: 0 = 262144 (Chrome/Safari), 1 = line absent
 *                          (RFC 8841 default 65536), 2 = 1073741823 (Firefox), 3 = explicit u32 below
 *                bit 5     explicit sctp-port u16 below (otherwise 5000)
 *                bits 6-7  reserved, must be 0
 *   [2..33]    responder Ed25519 identity public key
 *   [34..65]   responder X25519 ephemeral public key
 *   [66..69]   offer binding: first 4 bytes of SHA-256(DOMAIN || "binding" || offer nonce)
 *   [70..73]   issued-at, unix seconds (u32). Expires at issued-at + INVITATION_TTL_MS.
 *   [74..105]  DTLS certificate SHA-256 fingerprint (32 bytes)
 *   ice-ufrag  1 length byte (bit 7 = hex mode, bits 0-6 = character count) + packed chars
 *   ice-pwd    same encoding
 *              Hex mode (used iff the value is even-length lowercase hex, as Firefox emits):
 *              two characters per byte. Otherwise 6 bits per character over the 64 ICE
 *              characters A-Z a-z 0-9 + / (RFC 8839 ice-char), zero padding bits at the end.
 *              The real browser values are carried unchanged; the SDP is never munged.
 *   [u16]      sctp-port, only if flag bit 5 (never 5000: that is the implicit value)
 *   [u32]      max-message-size, only if code 3 (never one of the coded values)
 *   candidates count x { kind byte (bit 0 = IPv6, bit 1 = srflx, others 0), address
 *              (4 or 16 bytes), port u16 } -> 7 bytes IPv4, 19 bytes IPv6
 *   [..+64]    Ed25519 signature over SHA-256(DOMAIN || offer nonce (16) || all bytes above)
 *
 * The signature covers the FULL 16-byte offer nonce, not just the 4-byte binding, so an answer
 * can only ever be accepted for the offer it was made for. The binding exists so the decoder
 * can say "wrong_offer" instead of the vaguer "bad_signature".
 *
 * Fixed part: 106 bytes; with signature 170. Typical totals: Chrome/Safari (4/24-char ICE
 * credentials) 193 + 7 per IPv4 candidate; Firefox (8/32 hex) 192 + 7 per IPv4 candidate.
 *
 * Candidate selection (encoder):
 *   - Kept: component 1, UDP, typ host or srflx, literal IPv4/IPv6 address.
 *   - Dropped: mDNS ".local" hosts (the initiator cannot resolve them remotely, and a 36-char
 *     name does not fit), relay, TCP, prflx, component 2, anything unparsable.
 *     Same-LAN connectivity still works without the responder's host candidates: the
 *     responder has the initiator's full offer (including its .local hosts, which it can resolve
 *     on the LAN), sends ICE checks to them, and the initiator learns the responder's address
 *     as a peer-reflexive candidate.
 *   - Ranked: srflx IPv4, then global IPv6 / public host IPv4, then private host IPv4, then
 *     other IPv6; ties by the browser's own priority. Duplicates (same address and port) dropped.
 *   - At most 3, added greedily while the total stays within maxBytes. If candidates existed,
 *     at least one is always kept (too_large otherwise). Zero usable candidates is allowed:
 *     the link can then still form via peer-reflexive candidates as described above.
 *
 * SDP reconstruction assumptions (decoder), mirroring what libwebrtc (Chrome, Safari) emits:
 *   - One m=application section, "UDP/DTLS/SCTP webrtc-datachannel", port 9, c=IN IP4 0.0.0.0.
 *   - a=mid and a=group:BUNDLE use the mid from the initiator's own offer.
 *   - o= session id is derived from the fingerprint (deterministic, digits only, < 2^56).
 *   - Candidates get foundation 1..n, component 1, priority per RFC 8445 section 5.1.2.1
 *     (type preference host 126 / srflx 100, local preference 65535 - index, component 1);
 *     srflx lines carry "raddr 0.0.0.0 rport 0" (or "::" for IPv6), as Chrome writes when it
 *     hides the base address. Priorities only order candidate pairs; they do not affect
 *     whether a connection is possible.
 *   - IPv6 addresses are re-emitted in RFC 5952 canonical form (same address, maybe
 *     different text from what the browser wrote).
 *   - a=end-of-candidates is added: the responder used non-trickle ICE (peer.ts).
 *   - a=extmap-allow-mixed is omitted (it concerns RTP only).
 *
 * The decoded object is an Invitation with kind "answer". Its `nonce` is a 16-byte id derived
 * from the compact bytes and its `signature` is the compact signature, so it must NOT be
 * re-encoded with encodeInvitation (that signature would not verify as a p2p1 invitation).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { sign, verify } from "../identity/keypair";
import type { Ed25519KeyPair } from "../identity/types";
import { publicKeyToDidKey } from "../identity/didKey";
import { INVITATION_TTL_MS, type Invitation } from "./invitation";

export const COMPACT_ANSWER_VERSION = 1;
export const MAX_COMPACT_ANSWER_BYTES = 220;
/** Size the encoder aims for in typical cases (one or two IPv4 candidates). */
export const COMPACT_ANSWER_TARGET_BYTES = 200;
export const MAX_COMPACT_CANDIDATES = 3;

export type CompactAnswerErrorCode =
  | "too_large"
  | "malformed"
  | "bad_signature"
  | "wrong_offer"
  | "expired"
  | "unsupported_sdp";

export class CompactAnswerError extends Error {
  readonly code: CompactAnswerErrorCode;
  constructor(message: string, code: CompactAnswerErrorCode) {
    super(message);
    this.name = "CompactAnswerError";
    this.code = code;
  }
}

/** An answer Invitation rebuilt from compact bytes, plus the responder's did:key. */
export interface CompactAnswerInvitation extends Invitation {
  kind: "answer";
  answersNonce: Uint8Array;
  did: string;
}

export interface EncodeCompactAnswerArgs {
  /** The responder's local answer SDP, as returned by PeerLink.createAnswer. */
  answerSdp: string;
  identity: Ed25519KeyPair;
  ephemeralPublicKey: Uint8Array;
  /** Nonce of the offer being answered (Invitation.nonce of the decoded offer). */
  offerNonce: Uint8Array;
  now?: number;
  /** Size budget for candidate selection; defaults to MAX_COMPACT_ANSWER_BYTES. */
  maxBytes?: number;
}

const DOMAIN = new TextEncoder().encode("p2p-pure/compact-answer/v1\n");
const BINDING_TAG = new TextEncoder().encode("binding");
const ID_TAG = new TextEncoder().encode("answer-id");
const KEY_LEN = 32;
const NONCE_LEN = 16;
const BINDING_LEN = 4;
const FP_LEN = 32;
const SIG_LEN = 64;

const OFF_FLAGS = 1;
const OFF_IDENTITY = 2;
const OFF_EPHEMERAL = OFF_IDENTITY + KEY_LEN;
const OFF_BINDING = OFF_EPHEMERAL + KEY_LEN;
const OFF_ISSUED = OFF_BINDING + BINDING_LEN;
const OFF_FP = OFF_ISSUED + 4;
const FIXED_LEN = OFF_FP + FP_LEN; // 106

const FLAG_PASSIVE = 0x01;
const CAND_SHIFT = 1;
const CAND_MASK = 0x03 << CAND_SHIFT;
const MMS_SHIFT = 3;
const MMS_MASK = 0x03 << MMS_SHIFT;
const FLAG_SCTP_PORT = 0x20;
const FLAG_RESERVED = 0xc0;

const MMS_CHROME = 262144;
const MMS_FIREFOX = 1073741823;
const MMS_CODE_CHROME = 0;
const MMS_CODE_ABSENT = 1;
const MMS_CODE_FIREFOX = 2;
const MMS_CODE_EXPLICIT = 3;
const DEFAULT_SCTP_PORT = 5000;

const CAND_V6 = 0x01;
const CAND_SRFLX = 0x02;

const UFRAG_MIN = 4;
const UFRAG_MAX = 32;
const PWD_MIN = 22;
const PWD_MAX = 64;
const HEX_MODE = 0x80;
const ICE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/* ------------------------------------------------------------------ */
/* SDP parsing and validation                                          */
/* ------------------------------------------------------------------ */

export interface ParsedCandidate {
  type: "host" | "srflx";
  /** 4 bytes (IPv4) or 16 bytes (IPv6). */
  address: Uint8Array;
  port: number;
  /** Priority as written by the browser (0 if missing). */
  priority: number;
}

export interface ParsedDataChannelSdp {
  ufrag: string;
  pwd: string;
  /** SHA-256 DTLS fingerprint, 32 bytes. */
  fingerprint: Uint8Array;
  setup: "active" | "passive" | "actpass";
  mid: string;
  sctpPort: number;
  /** null when the SDP has no a=max-message-size line. */
  maxMessageSize: number | null;
  /** Usable candidates (UDP host/srflx with a literal IP), in SDP order. */
  candidates: ParsedCandidate[];
  /** Raw counts, for diagnostics and tests. */
  droppedCandidates: number;
  relayCandidates: number;
}

function unsupported(message: string): CompactAnswerError {
  return new CompactAnswerError(message, "unsupported_sdp");
}

function parseIpv4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1];
    if (part.length > 1 && part[0] === "0") return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** Parses textual IPv6 (with "::" and an optional dotted IPv4 tail). No zone ids. */
export function parseIpv6(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.length > 45) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (i === pieces.length - 1 && p.includes(".")) {
        const v4 = parseIpv4(p);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
        groups.push(parseInt(p, 16));
      }
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  });
  return out;
}

/** RFC 5952 canonical text for a 16-byte IPv6 address. */
export function formatIpv6(b: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((b[i * 2] << 8) | b[i * 2 + 1]);
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  return hex.slice(0, bestStart).join(":") + "::" + hex.slice(bestStart + bestLen).join(":");
}

function formatAddress(a: Uint8Array): string {
  return a.length === 4 ? Array.from(a).join(".") : formatIpv6(a);
}

function parseFingerprint(value: string): Uint8Array | null {
  const parts = value.split(":");
  if (parts.length !== FP_LEN) return null;
  const out = new Uint8Array(FP_LEN);
  for (let i = 0; i < FP_LEN; i++) {
    if (!/^[0-9a-fA-F]{2}$/.test(parts[i])) return null;
    out[i] = parseInt(parts[i], 16);
  }
  return out;
}

function isIceChars(s: string): boolean {
  return /^[A-Za-z0-9+/]+$/.test(s);
}

/**
 * Parses a WebRTC SDP that must be data-channel only (one m=application
 * "UDP/DTLS/SCTP webrtc-datachannel" section). Throws unsupported_sdp otherwise.
 * Relay, TCP and mDNS candidates are counted but not returned.
 */
export function parseDataChannelSdp(sdp: string): ParsedDataChannelSdp {
  if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > 16 * 1024) {
    throw unsupported("SDP липсва или е твърде голям.");
  }
  const lines = sdp.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines[0] !== "v=0") throw unsupported("SDP не започва с v=0.");
  const mLines = lines.filter((l) => l.startsWith("m="));
  if (mLines.length !== 1) throw unsupported("Очаква се точно една медийна секция (само канал за данни).");
  const m = /^m=application (\d+) UDP\/DTLS\/SCTP webrtc-datachannel$/.exec(mLines[0]);
  if (!m || Number(m[1]) === 0) throw unsupported("Поддържа се само канал за данни (webrtc-datachannel).");

  const ufrags = new Set<string>();
  const pwds = new Set<string>();
  let fingerprint: Uint8Array | null = null;
  let setup: ParsedDataChannelSdp["setup"] | null = null;
  let mid: string | null = null;
  let sctpPort = DEFAULT_SCTP_PORT;
  let maxMessageSize: number | null = null;
  const candidates: ParsedCandidate[] = [];
  let dropped = 0;
  let relay = 0;

  for (const line of lines) {
    if (!line.startsWith("a=")) continue;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line.slice(2) : line.slice(2, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1);
    switch (name) {
      case "ice-ufrag":
        ufrags.add(value);
        break;
      case "ice-pwd":
        pwds.add(value);
        break;
      case "fingerprint": {
        const sp = value.indexOf(" ");
        if (sp > 0 && value.slice(0, sp).toLowerCase() === "sha-256" && !fingerprint) {
          fingerprint = parseFingerprint(value.slice(sp + 1).trim());
          if (!fingerprint) throw unsupported("DTLS отпечатъкът е повреден.");
        }
        break;
      }
      case "setup":
        if (value !== "active" && value !== "passive" && value !== "actpass") {
          throw unsupported("Непозната DTLS роля.");
        }
        setup = value;
        break;
      case "mid":
        mid = value;
        break;
      case "sctp-port": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw unsupported("Невалиден sctp-port.");
        sctpPort = n;
        break;
      }
      case "max-message-size": {
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n > 0xffffffff) {
          throw unsupported("Невалиден max-message-size.");
        }
        maxMessageSize = n;
        break;
      }
      case "candidate": {
        const p = value.split(/\s+/);
        // foundation component transport priority address port "typ" type ...
        const typ = p[6] === "typ" ? p[7] : undefined;
        if (typ === "relay") {
          relay++;
          dropped++;
          break;
        }
        if (
          p.length < 8 ||
          p[1] !== "1" ||
          p[2].toLowerCase() !== "udp" ||
          (typ !== "host" && typ !== "srflx")
        ) {
          dropped++;
          break;
        }
        const port = Number(p[5]);
        const addr = parseIpv4(p[4]) ?? parseIpv6(p[4]);
        if (!addr || !Number.isInteger(port) || port < 1 || port > 65535 || addr.every((x) => x === 0)) {
          dropped++; // includes "<uuid>.local" mDNS names
          break;
        }
        const prio = Number(p[3]);
        candidates.push({
          type: typ,
          address: addr,
          port,
          priority: Number.isSafeInteger(prio) && prio >= 0 ? prio : 0,
        });
        break;
      }
      default:
        break;
    }
  }

  if (ufrags.size !== 1 || pwds.size !== 1) throw unsupported("Липсват или са разминати ICE данните.");
  const ufrag = [...ufrags][0];
  const pwd = [...pwds][0];
  if (!isIceChars(ufrag) || !isIceChars(pwd)) throw unsupported("ICE данните съдържат непозволени знаци.");
  if (!fingerprint) throw unsupported("Липсва DTLS отпечатък sha-256.");
  if (!setup) throw unsupported("Липсва a=setup.");
  if (mid === null || !/^[A-Za-z0-9_-]{1,16}$/.test(mid)) throw unsupported("Липсва или е невалиден a=mid.");

  return {
    ufrag,
    pwd,
    fingerprint,
    setup,
    mid,
    sctpPort,
    maxMessageSize,
    candidates,
    droppedCandidates: dropped,
    relayCandidates: relay,
  };
}

/**
 * Checks an answer SDP the way this app expects it: data-channel only, ICE credentials,
 * sha-256 fingerprint, setup active/passive, no relay candidates. Throws unsupported_sdp.
 * peer.ts itself has no validator (it hands SDP straight to the browser); this is the
 * explicit version of those expectations, applied to every reconstructed answer.
 */
export function validateDataChannelAnswerSdp(sdp: string): ParsedDataChannelSdp {
  const parsed = parseDataChannelSdp(sdp);
  if (parsed.setup === "actpass") throw unsupported("Отговорът не може да е actpass.");
  if (parsed.relayCandidates > 0) throw unsupported("Отговорът съдържа relay кандидати.");
  return parsed;
}

/* ------------------------------------------------------------------ */
/* Packing helpers                                                     */
/* ------------------------------------------------------------------ */

function packIceString(s: string): Uint8Array {
  if (/^[0-9a-f]+$/.test(s) && s.length % 2 === 0) {
    const out = new Uint8Array(1 + s.length / 2);
    out[0] = HEX_MODE | s.length;
    for (let i = 0; i < s.length / 2; i++) out[1 + i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const nBytes = Math.ceil((s.length * 6) / 8);
  const out = new Uint8Array(1 + nBytes);
  out[0] = s.length;
  let acc = 0;
  let bits = 0;
  let o = 1;
  for (const ch of s) {
    acc = (acc << 6) | ICE_ALPHABET.indexOf(ch);
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out[o] = (acc << (8 - bits)) & 0xff;
  return out;
}

function malformed(message: string): CompactAnswerError {
  return new CompactAnswerError(message, "malformed");
}

class Reader {
  pos: number;
  private readonly b: Uint8Array;
  private readonly end: number;
  constructor(b: Uint8Array, start: number, end: number) {
    this.b = b;
    this.pos = start;
    this.end = end;
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.end) throw malformed("Отговорът е непълен.");
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0];
  }
  u16(): number {
    const t = this.take(2);
    return (t[0] << 8) | t[1];
  }
  u32(): number {
    const t = this.take(4);
    return ((t[0] << 24) >>> 0) + (t[1] << 16) + (t[2] << 8) + t[3];
  }
}

function readIceString(r: Reader, min: number, max: number): string {
  const head = r.u8();
  const hex = (head & HEX_MODE) !== 0;
  const len = head & 0x7f;
  if (len < min || len > max) throw malformed("ICE данните са с невалидна дължина.");
  if (hex) {
    if (len % 2 !== 0) throw malformed("ICE данните са повредени.");
    return Array.from(r.take(len / 2), (x) => x.toString(16).padStart(2, "0")).join("");
  }
  const data = r.take(Math.ceil((len * 6) / 8));
  let acc = 0;
  let bits = 0;
  let s = "";
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 6 && s.length < len) {
      bits -= 6;
      s += ICE_ALPHABET[(acc >> bits) & 0x3f];
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw malformed("ICE данните не са в канонична форма.");
  if (/^[0-9a-f]+$/.test(s) && s.length % 2 === 0) throw malformed("ICE данните не са в канонична форма.");
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function offerBinding(offerNonce: Uint8Array): Uint8Array {
  return sha256(concat([DOMAIN, BINDING_TAG, offerNonce])).slice(0, BINDING_LEN);
}

function signedDigest(offerNonce: Uint8Array, body: Uint8Array): Uint8Array {
  return sha256(concat([DOMAIN, offerNonce, body]));
}

function isPrivateV4(a: Uint8Array): boolean {
  return (
    a[0] === 10 ||
    (a[0] === 192 && a[1] === 168) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 169 && a[1] === 254) ||
    a[0] === 127 ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127)
  );
}

function candidateRank(c: ParsedCandidate): number {
  if (c.address.length === 4) {
    if (c.type === "srflx") return 0;
    return isPrivateV4(c.address) ? 2 : 1;
  }
  const globalV6 = (c.address[0] & 0xe0) === 0x20; // 2000::/3
  return globalV6 ? 1 : 3;
}

function encodeCandidate(c: ParsedCandidate): Uint8Array {
  const out = new Uint8Array(1 + c.address.length + 2);
  out[0] = (c.address.length === 16 ? CAND_V6 : 0) | (c.type === "srflx" ? CAND_SRFLX : 0);
  out.set(c.address, 1);
  out[1 + c.address.length] = c.port >> 8;
  out[2 + c.address.length] = c.port & 0xff;
  return out;
}

/** Orders usable candidates by usefulness and removes duplicates (same address and port). */
export function rankCandidates(candidates: ParsedCandidate[]): ParsedCandidate[] {
  const seen = new Set<string>();
  const unique: ParsedCandidate[] = [];
  for (const c of candidates) {
    const key = `${formatAddress(c.address)}|${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique
    .map((c, i) => ({ c, i }))
    .sort((a, b) => candidateRank(a.c) - candidateRank(b.c) || b.c.priority - a.c.priority || a.i - b.i)
    .map((x) => x.c);
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/** Responder: build from its local answer SDP (as produced by PeerLink.createAnswer) and keys. */
export function encodeCompactAnswer(args: EncodeCompactAnswerArgs): Uint8Array {
  const { identity, ephemeralPublicKey, offerNonce } = args;
  const now = args.now ?? Date.now();
  const maxBytes = Math.min(args.maxBytes ?? MAX_COMPACT_ANSWER_BYTES, MAX_COMPACT_ANSWER_BYTES);
  if (identity.publicKey.length !== KEY_LEN || ephemeralPublicKey.length !== KEY_LEN) {
    throw malformed("Ключовете трябва да са по 32 байта.");
  }
  if (offerNonce.length !== NONCE_LEN) throw malformed("Номерът на поканата трябва да е 16 байта.");

  // Relay/TCP/mDNS candidates are dropped below, not rejected: the parser never returns them.
  const sdp = parseDataChannelSdp(args.answerSdp);
  if (sdp.setup === "actpass") throw unsupported("Отговорът не може да е actpass.");
  if (sdp.ufrag.length < UFRAG_MIN || sdp.pwd.length < PWD_MIN) {
    throw unsupported("ICE данните са твърде къси.");
  }
  if (sdp.ufrag.length > UFRAG_MAX || sdp.pwd.length > PWD_MAX) {
    throw new CompactAnswerError("ICE данните са твърде дълги за кратък отговор.", "too_large");
  }

  let mmsCode: number;
  if (sdp.maxMessageSize === null) mmsCode = MMS_CODE_ABSENT;
  else if (sdp.maxMessageSize === MMS_CHROME) mmsCode = MMS_CODE_CHROME;
  else if (sdp.maxMessageSize === MMS_FIREFOX) mmsCode = MMS_CODE_FIREFOX;
  else mmsCode = MMS_CODE_EXPLICIT;
  const explicitSctp = sdp.sctpPort !== DEFAULT_SCTP_PORT;

  const issuedAt = Math.floor(now / 1000);
  if (issuedAt < 0 || issuedAt > 0xffffffff) throw malformed("Невалидно време.");

  const fixed = new Uint8Array(FIXED_LEN);
  fixed[0] = COMPACT_ANSWER_VERSION;
  fixed.set(identity.publicKey, OFF_IDENTITY);
  fixed.set(ephemeralPublicKey, OFF_EPHEMERAL);
  fixed.set(offerBinding(offerNonce), OFF_BINDING);
  new DataView(fixed.buffer).setUint32(OFF_ISSUED, issuedAt);
  fixed.set(sdp.fingerprint, OFF_FP);

  const variable: Uint8Array[] = [packIceString(sdp.ufrag), packIceString(sdp.pwd)];
  if (explicitSctp) variable.push(new Uint8Array([sdp.sctpPort >> 8, sdp.sctpPort & 0xff]));
  if (mmsCode === MMS_CODE_EXPLICIT) {
    const v = new Uint8Array(4);
    new DataView(v.buffer).setUint32(0, sdp.maxMessageSize as number);
    variable.push(v);
  }

  let size = FIXED_LEN + variable.reduce((n, p) => n + p.length, 0) + SIG_LEN;
  const ranked = rankCandidates(sdp.candidates);
  const chosen: Uint8Array[] = [];
  for (const c of ranked) {
    if (chosen.length >= MAX_COMPACT_CANDIDATES) break;
    const enc = encodeCandidate(c);
    if (size + enc.length > maxBytes) continue; // a smaller (IPv4) one later may still fit
    chosen.push(enc);
    size += enc.length;
  }
  if (size > maxBytes || (ranked.length > 0 && chosen.length === 0)) {
    throw new CompactAnswerError("Отговорът не се събира в кратката форма.", "too_large");
  }

  fixed[OFF_FLAGS] =
    (sdp.setup === "passive" ? FLAG_PASSIVE : 0) |
    (chosen.length << CAND_SHIFT) |
    (mmsCode << MMS_SHIFT) |
    (explicitSctp ? FLAG_SCTP_PORT : 0);

  const body = concat([fixed, ...variable, ...chosen]);
  const signature = sign(signedDigest(offerNonce, body), identity);
  return concat([body, signature]);
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

interface DecodedFields {
  passive: boolean;
  identity: Uint8Array;
  ephemeral: Uint8Array;
  binding: Uint8Array;
  issuedAt: number;
  fingerprint: Uint8Array;
  ufrag: string;
  pwd: string;
  sctpPort: number;
  maxMessageSize: number | null;
  candidates: { srflx: boolean; address: Uint8Array; port: number }[];
  body: Uint8Array;
  signature: Uint8Array;
}

function parseCompact(bytes: Uint8Array): DecodedFields {
  if (!(bytes instanceof Uint8Array)) throw malformed("Отговорът не е байтове.");
  if (bytes.length > MAX_COMPACT_ANSWER_BYTES) {
    throw new CompactAnswerError("Отговорът е твърде голям.", "too_large");
  }
  if (bytes.length < FIXED_LEN + SIG_LEN + 2) throw malformed("Отговорът е твърде къс.");
  if (bytes[0] !== COMPACT_ANSWER_VERSION) throw malformed("Неподдържана версия на отговора.");
  const flags = bytes[OFF_FLAGS];
  if (flags & FLAG_RESERVED) throw malformed("Отговорът съдържа непознати флагове.");
  const nCand = (flags & CAND_MASK) >> CAND_SHIFT;
  const mmsCode = (flags & MMS_MASK) >> MMS_SHIFT;

  const sigStart = bytes.length - SIG_LEN;
  const r = new Reader(bytes, FIXED_LEN, sigStart);
  const ufrag = readIceString(r, UFRAG_MIN, UFRAG_MAX);
  const pwd = readIceString(r, PWD_MIN, PWD_MAX);
  let sctpPort = DEFAULT_SCTP_PORT;
  if (flags & FLAG_SCTP_PORT) {
    sctpPort = r.u16();
    if (sctpPort === 0 || sctpPort === DEFAULT_SCTP_PORT) throw malformed("sctp-port не е в канонична форма.");
  }
  let maxMessageSize: number | null;
  if (mmsCode === MMS_CODE_CHROME) maxMessageSize = MMS_CHROME;
  else if (mmsCode === MMS_CODE_FIREFOX) maxMessageSize = MMS_FIREFOX;
  else if (mmsCode === MMS_CODE_ABSENT) maxMessageSize = null;
  else {
    maxMessageSize = r.u32();
    if (maxMessageSize === MMS_CHROME || maxMessageSize === MMS_FIREFOX) {
      throw malformed("max-message-size не е в канонична форма.");
    }
  }
  const candidates: DecodedFields["candidates"] = [];
  for (let i = 0; i < nCand; i++) {
    const kind = r.u8();
    if (kind & ~(CAND_V6 | CAND_SRFLX)) throw malformed("Непознат вид кандидат.");
    const address = r.take(kind & CAND_V6 ? 16 : 4);
    const port = r.u16();
    if (port === 0 || address.every((x) => x === 0)) throw malformed("Невалиден кандидат.");
    candidates.push({ srflx: (kind & CAND_SRFLX) !== 0, address, port });
  }
  if (r.pos !== sigStart) throw malformed("Отговорът има излишни байтове.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    passive: (flags & FLAG_PASSIVE) !== 0,
    identity: bytes.slice(OFF_IDENTITY, OFF_IDENTITY + KEY_LEN),
    ephemeral: bytes.slice(OFF_EPHEMERAL, OFF_EPHEMERAL + KEY_LEN),
    binding: bytes.slice(OFF_BINDING, OFF_BINDING + BINDING_LEN),
    issuedAt: view.getUint32(OFF_ISSUED),
    fingerprint: bytes.slice(OFF_FP, OFF_FP + FP_LEN),
    ufrag,
    pwd,
    sctpPort,
    maxMessageSize,
    candidates,
    body: bytes.slice(0, sigStart),
    signature: bytes.slice(sigStart),
  };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Builds the minimal data-channel answer SDP described in the file header. */
function buildAnswerSdp(f: DecodedFields, mid: string): string {
  let sessionId = 0n;
  for (let i = 0; i < 7; i++) sessionId = (sessionId << 8n) | BigInt(f.fingerprint[i]);
  if (sessionId === 0n) sessionId = 1n;
  const fp = Array.from(f.fingerprint, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const lines = [
    "v=0",
    `o=- ${sessionId.toString()} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${mid}`,
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
  ];
  f.candidates.forEach((c, i) => {
    const typePref = c.srflx ? 100 : 126;
    const priority = typePref * 2 ** 24 + (65535 - i) * 2 ** 8 + (256 - 1);
    const addr = formatAddress(c.address);
    const rel = c.srflx ? ` raddr ${c.address.length === 4 ? "0.0.0.0" : "::"} rport 0` : "";
    lines.push(`a=candidate:${i + 1} 1 udp ${priority} ${addr} ${c.port} typ ${c.srflx ? "srflx" : "host"}${rel}`);
  });
  lines.push(
    `a=ice-ufrag:${f.ufrag}`,
    `a=ice-pwd:${f.pwd}`,
    "a=ice-options:trickle",
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${f.passive ? "passive" : "active"}`,
    `a=mid:${mid}`,
    `a=sctp-port:${f.sctpPort}`,
  );
  if (f.maxMessageSize !== null) lines.push(`a=max-message-size:${f.maxMessageSize}`);
  lines.push("a=end-of-candidates");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Initiator: verify and rebuild an answer Invitation usable exactly where a decoded p2p1
 * answer is used today (PeerLink.acceptAnswer(sdp), completeHandshake(publicKey),
 * SecureSession.derive(publicKey, ephemeralPublicKey)). Throws CompactAnswerError.
 */
export function decodeCompactAnswer(
  bytes: Uint8Array,
  offer: Invitation,
  now = Date.now(),
): CompactAnswerInvitation {
  if (offer.kind !== "offer" || offer.nonce.length !== NONCE_LEN) {
    throw new CompactAnswerError("Няма активна покана за този отговор.", "wrong_offer");
  }
  const f = parseCompact(bytes);

  let sigOk = false;
  try {
    sigOk = verify(f.signature, signedDigest(offer.nonce, f.body), f.identity);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    if (!constantTimeEqual(f.binding, offerBinding(offer.nonce))) {
      throw new CompactAnswerError("Този отговор не е за тази покана.", "wrong_offer");
    }
    throw new CompactAnswerError("Подписът на отговора е невалиден.", "bad_signature");
  }

  const expiresAt = f.issuedAt * 1000 + INVITATION_TTL_MS;
  if (expiresAt <= now) {
    throw new CompactAnswerError("Отговорът е изтекъл. Започнете отначало.", "expired");
  }
  if (f.issuedAt * 1000 > now + INVITATION_TTL_MS) {
    throw new CompactAnswerError("Часовниците на двете устройства се разминават твърде много.", "expired");
  }

  const offerSdp = parseDataChannelSdp(offer.sdp);
  const sdp = buildAnswerSdp(f, offerSdp.mid);
  validateDataChannelAnswerSdp(sdp);

  return {
    kind: "answer",
    publicKey: f.identity,
    ephemeralPublicKey: f.ephemeral,
    nonce: sha256(concat([DOMAIN, ID_TAG, bytes])).slice(0, NONCE_LEN),
    expiresAt,
    answersNonce: offer.nonce.slice(),
    sdp,
    signature: f.signature,
    did: publicKeyToDidKey(f.identity),
  };
}
