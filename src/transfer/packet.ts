/**
 * Signalling packets of the one-time device transfer (see docs/MULTIDEVICE.md).
 *
 * The old device shows an OFFER, the new device scans it and shows an ANSWER. Both are QR codes
 * (or pasted text). Unlike a contact invitation they carry no identity key and no signature:
 * the new device has no identity yet, and the old device must not put its DID on a screen.
 * Integrity comes from the transcript: the SDPs and both ephemeral keys go into the key
 * derivation (session.ts), so a changed packet gives different keys and the channel fails.
 *
 * Wire layout (before raw-deflate + base64url + "p2pt1:" prefix), version 1:
 *   [0]      version (0x01)
 *   [1]      kind: 'o' (offer) or 'a' (answer)
 *   [2..33]  ephemeral X25519 public key (fresh for this transfer, used once)
 *   [34..49] nonce (16 bytes). The answer repeats the offer's nonce.
 *   [50..55] expiry, unix ms, 6 bytes big-endian
 *   [56..]   SDP, UTF-8
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { base64UrlToBytes, bytesToBase64Url, deflateRaw, inflateRaw } from "../p2p/encoding";

export const TRANSFER_PREFIX = "p2pt1:";
/** Same compressed bytes as hex, for typing or pasting without a camera. */
export const TRANSFER_HEX_PREFIX = "p2pt1h:";
/** The whole transfer (scan, connect, compare words, send) must finish inside this window. */
export const TRANSFER_TTL_MS = 10 * 60 * 1000;
/** Clock difference tolerated between the two devices when checking expiry. */
export const CLOCK_SKEW_MS = 60 * 1000;

const VERSION = 1;
const KIND_OFFER = 0x6f; // 'o'
const KIND_ANSWER = 0x61; // 'a'
const KEY_LEN = 32;
export const NONCE_LEN = 16;
const OFF_KEY = 2;
const OFF_NONCE = OFF_KEY + KEY_LEN;
const OFF_EXPIRY = OFF_NONCE + NONCE_LEN;
const HEADER_LEN = OFF_EXPIRY + 6;
const MAX_SDP_BYTES = 16 * 1024;
const MAX_PACKET_BYTES = HEADER_LEN + MAX_SDP_BYTES;

export type TransferErrorCode =
  | "MALFORMED"
  | "EXPIRED"
  | "WRONG_KIND"
  | "WRONG_NONCE"
  | "REPLAYED"
  | "BAD_KEY"
  | "BAD_STATE"
  | "TAMPERED"
  | "ABORTED"
  | "SAS_MISMATCH"
  | "BAD_BUNDLE"
  | "IDENTITY_MISMATCH"
  | "TIMEOUT";

export class TransferError extends Error {
  readonly code: TransferErrorCode;
  constructor(message: string, code: TransferErrorCode) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

export interface TransferPacket {
  kind: "offer" | "answer";
  ephemeralPublicKey: Uint8Array;
  nonce: Uint8Array;
  expiresAt: number;
  sdp: string;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A 32-byte X25519 key that is not the all-zero point (it would give an all-zero secret). */
function sanePublicKey(key: Uint8Array): boolean {
  return key.length === KEY_LEN && key.some((b) => b !== 0);
}

function toBytes(packet: TransferPacket): Uint8Array {
  if (!sanePublicKey(packet.ephemeralPublicKey)) throw new TransferError("Невалиден ключ.", "BAD_KEY");
  if (packet.nonce.length !== NONCE_LEN) throw new TransferError("Невалиден nonce.", "MALFORMED");
  const sdp = new TextEncoder().encode(packet.sdp);
  if (sdp.length === 0 || sdp.length > MAX_SDP_BYTES) throw new TransferError("Невалиден SDP.", "MALFORMED");
  const out = new Uint8Array(HEADER_LEN + sdp.length);
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = packet.kind === "offer" ? KIND_OFFER : KIND_ANSWER;
  out.set(packet.ephemeralPublicKey, OFF_KEY);
  out.set(packet.nonce, OFF_NONCE);
  view.setUint16(OFF_EXPIRY, Math.floor(packet.expiresAt / 2 ** 32));
  view.setUint32(OFF_EXPIRY + 2, packet.expiresAt >>> 0);
  out.set(sdp, HEADER_LEN);
  return out;
}

function fromBytes(bytes: Uint8Array): TransferPacket {
  if (bytes.length <= HEADER_LEN || bytes.length > MAX_PACKET_BYTES || bytes[0] !== VERSION) {
    throw new TransferError("Кодът не е валиден код за прехвърляне.", "MALFORMED");
  }
  const kindByte = bytes[1];
  if (kindByte !== KIND_OFFER && kindByte !== KIND_ANSWER) {
    throw new TransferError("Кодът не е валиден код за прехвърляне.", "MALFORMED");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expiresAt = view.getUint16(OFF_EXPIRY) * 2 ** 32 + view.getUint32(OFF_EXPIRY + 2);
  const ephemeralPublicKey = bytes.slice(OFF_KEY, OFF_KEY + KEY_LEN);
  if (!sanePublicKey(ephemeralPublicKey)) throw new TransferError("Невалиден ключ.", "BAD_KEY");
  let sdp: string;
  try {
    sdp = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(HEADER_LEN));
  } catch {
    throw new TransferError("Кодът не е валиден код за прехвърляне.", "MALFORMED");
  }
  return {
    kind: kindByte === KIND_OFFER ? "offer" : "answer",
    ephemeralPublicKey,
    nonce: bytes.slice(OFF_NONCE, OFF_NONCE + NONCE_LEN),
    expiresAt,
    sdp,
  };
}

const HEX_RE = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new TransferError("Невалиден hex код.", "MALFORMED");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function encodeTransferPacket(packet: TransferPacket): Promise<string> {
  return TRANSFER_PREFIX + bytesToBase64Url(await deflateRaw(toBytes(packet)));
}

export async function encodeTransferPacketHex(packet: TransferPacket): Promise<string> {
  const compressed = await deflateRaw(toBytes(packet));
  return TRANSFER_HEX_PREFIX + Array.from(compressed, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decodes scanned or pasted text. Expiry is checked here so an old code is refused at once. */
export async function decodeTransferPacket(text: string, now = Date.now()): Promise<TransferPacket> {
  const trimmed = text.trim();
  let compressed: Uint8Array;
  try {
    if (trimmed.startsWith(TRANSFER_HEX_PREFIX)) {
      compressed = hexToBytes(trimmed.slice(TRANSFER_HEX_PREFIX.length).toLowerCase());
    } else if (trimmed.startsWith(TRANSFER_PREFIX)) {
      compressed = base64UrlToBytes(trimmed.slice(TRANSFER_PREFIX.length));
    } else {
      throw new TransferError("Това не е код за прехвърляне.", "MALFORMED");
    }
  } catch (err) {
    if (err instanceof TransferError) throw err;
    throw new TransferError("Кодът не е валиден код за прехвърляне.", "MALFORMED");
  }
  let bytes: Uint8Array;
  try {
    bytes = await inflateRaw(compressed, MAX_PACKET_BYTES);
  } catch {
    throw new TransferError("Кодът не е валиден код за прехвърляне.", "MALFORMED");
  }
  const packet = fromBytes(bytes);
  if (packet.expiresAt + CLOCK_SKEW_MS < now) {
    throw new TransferError("Кодът е изтекъл. Започни прехвърлянето отначало.", "EXPIRED");
  }
  return packet;
}

/** Fresh offer packet fields (the caller supplies the SDP and the ephemeral public key). */
export function newOffer(sdp: string, ephemeralPublicKey: Uint8Array, now = Date.now()): TransferPacket {
  return {
    kind: "offer",
    ephemeralPublicKey,
    nonce: crypto.getRandomValues(new Uint8Array(NONCE_LEN)),
    expiresAt: now + TRANSFER_TTL_MS,
    sdp,
  };
}

/** An answer repeats the offer's nonce and expiry: it can only belong to that one offer. */
export function newAnswer(offer: TransferPacket, sdp: string, ephemeralPublicKey: Uint8Array): TransferPacket {
  return { kind: "answer", ephemeralPublicKey, nonce: offer.nonce, expiresAt: offer.expiresAt, sdp };
}

export function newEphemeral(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}
