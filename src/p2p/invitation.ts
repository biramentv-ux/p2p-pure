/**
 * Signed invitation codec: the payload carried inside each QR code.
 *
 * Wire layout (before base64url + "p2p1:" prefix), version 2:
 *   [0]        version (0x02)
 *   [1]        kind: 'o' (offer) or 'a' (answer)
 *   [2..33]    sender Ed25519 identity public key
 *   [34..65]   sender ephemeral X25519 public key (fresh per invitation)
 *   [66..81]   nonce (16 random bytes, identifies this invitation)
 *   [82..87]   expiry, unix ms, 6 bytes big-endian
 *   [88..103]  answers-nonce (16 bytes) — answer only
 *   [..+64]    Ed25519 signature over DOMAIN || header || sdp-utf8
 *   [..end]    raw-deflate(sdp-utf8)
 *
 * The signature covers the ephemeral key, so the session keys derived from
 * it are bound to the identity that signed the invitation.
 *
 * Why sign the SDP: it contains the DTLS certificate fingerprint. Signing it
 * binds the WebRTC transport to the sender's identity key. Trust in *which*
 * person owns that key comes from the safety-code comparison, not from here.
 */
import { sign, verify } from "../identity/keypair";
import type { Ed25519KeyPair } from "../identity/types";
import { base64UrlToBytes, bytesToBase64Url, deflateRaw, inflateRaw } from "./encoding";

export const INVITATION_PREFIX = "p2p1:";
/** Same bytes as INVITATION_PREFIX, written as hex for typing or copy-paste without a camera. */
export const INVITATION_HEX_PREFIX = "p2p1h:";
export const INVITATION_TTL_MS = 10 * 60 * 1000;

const VERSION = 2;
const KIND_OFFER = 0x6f; // 'o'
const KIND_ANSWER = 0x61; // 'a'
const KEY_LEN = 32;
const NONCE_LEN = 16;
const EXPIRY_LEN = 6;
const SIG_LEN = 64;
const MAX_SDP_BYTES = 16 * 1024;
const SIG_DOMAIN = new TextEncoder().encode("p2p-messenger/invitation/v2\n");

const OFF_IDENTITY = 2;
const OFF_EPHEMERAL = OFF_IDENTITY + KEY_LEN;
const OFF_NONCE = OFF_EPHEMERAL + KEY_LEN;
const OFF_EXPIRY = OFF_NONCE + NONCE_LEN;
const OFF_ANSWERS = OFF_EXPIRY + EXPIRY_LEN;

export type InvitationKind = "offer" | "answer";

export type InvitationErrorCode =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "WRONG_KIND"
  | "INVALID_FIELD";

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;
  constructor(message: string, code: InvitationErrorCode) {
    super(message);
    this.name = "InvitationError";
    this.code = code;
  }
}

export interface Invitation {
  kind: InvitationKind;
  /** Sender's Ed25519 identity public key. */
  publicKey: Uint8Array;
  /** Sender's ephemeral X25519 public key for this invitation. */
  ephemeralPublicKey: Uint8Array;
  /** Identifies this invitation; an answer references the offer's nonce. */
  nonce: Uint8Array;
  /** Unix ms after which the invitation must be rejected. */
  expiresAt: number;
  /** Answer only: nonce of the offer being answered. */
  answersNonce?: Uint8Array;
  sdp: string;
  signature: Uint8Array;
}

export interface CreateInvitationOptions {
  answersNonce?: Uint8Array;
  now?: number;
  nonce?: Uint8Array;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function headerLength(kind: InvitationKind): number {
  return OFF_ANSWERS + (kind === "answer" ? NONCE_LEN : 0);
}

function buildHeader(
  kind: InvitationKind,
  publicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array,
  expiresAt: number,
  answersNonce?: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(headerLength(kind));
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = kind === "offer" ? KIND_OFFER : KIND_ANSWER;
  out.set(publicKey, OFF_IDENTITY);
  out.set(ephemeralPublicKey, OFF_EPHEMERAL);
  out.set(nonce, OFF_NONCE);
  // 48-bit big-endian expiry: high 16 bits, then low 32 bits.
  view.setUint16(OFF_EXPIRY, Math.floor(expiresAt / 2 ** 32));
  view.setUint32(OFF_EXPIRY + 2, expiresAt >>> 0);
  if (answersNonce) out.set(answersNonce, OFF_ANSWERS);
  return out;
}

function signedMessage(header: Uint8Array, sdpBytes: Uint8Array): Uint8Array {
  const msg = new Uint8Array(SIG_DOMAIN.length + header.length + sdpBytes.length);
  msg.set(SIG_DOMAIN, 0);
  msg.set(header, SIG_DOMAIN.length);
  msg.set(sdpBytes, SIG_DOMAIN.length + header.length);
  return msg;
}

export function createInvitation(
  kind: InvitationKind,
  sdp: string,
  identity: Ed25519KeyPair,
  ephemeralPublicKey: Uint8Array,
  options: CreateInvitationOptions = {},
): Invitation {
  if (kind === "answer" && !options.answersNonce) {
    throw new InvitationError("An answer must reference the offer nonce.", "INVALID_FIELD");
  }
  if (options.answersNonce && options.answersNonce.length !== NONCE_LEN) {
    throw new InvitationError("answersNonce must be 16 bytes.", "INVALID_FIELD");
  }
  if (ephemeralPublicKey.length !== KEY_LEN) {
    throw new InvitationError("Ephemeral key must be 32 bytes.", "INVALID_FIELD");
  }
  const now = options.now ?? Date.now();
  const nonce = options.nonce ?? randomBytes(NONCE_LEN);
  const expiresAt = now + INVITATION_TTL_MS;
  const header = buildHeader(
    kind,
    identity.publicKey,
    ephemeralPublicKey,
    nonce,
    expiresAt,
    options.answersNonce,
  );
  const sdpBytes = new TextEncoder().encode(sdp);
  const signature = sign(signedMessage(header, sdpBytes), identity);
  return {
    kind,
    publicKey: identity.publicKey,
    ephemeralPublicKey,
    nonce,
    expiresAt,
    answersNonce: options.answersNonce,
    sdp,
    signature,
  };
}

export async function encodeInvitation(inv: Invitation): Promise<string> {
  const header = buildHeader(
    inv.kind,
    inv.publicKey,
    inv.ephemeralPublicKey,
    inv.nonce,
    inv.expiresAt,
    inv.answersNonce,
  );
  const compressedSdp = await deflateRaw(new TextEncoder().encode(inv.sdp));
  const body = new Uint8Array(header.length + SIG_LEN + compressedSdp.length);
  body.set(header, 0);
  body.set(inv.signature, header.length);
  body.set(compressedSdp, header.length + SIG_LEN);
  return INVITATION_PREFIX + bytesToBase64Url(body);
}

/** Hex form of the same invitation. Use when the other device has no camera. */
export async function encodeInvitationHex(inv: Invitation): Promise<string> {
  const b64 = await encodeInvitation(inv);
  const bytes = base64UrlToBytes(b64.slice(INVITATION_PREFIX.length));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return INVITATION_HEX_PREFIX + hex;
}

/** Converts either accepted text form to the canonical "p2p1:" base64url form. */
function normalizePayload(payload: string): string {
  const trimmed = payload.replace(/\s+/g, "");
  if (!trimmed.startsWith(INVITATION_HEX_PREFIX)) return trimmed;
  const hex = trimmed.slice(INVITATION_HEX_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new InvitationError("Invitation hex is malformed.", "MALFORMED");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return INVITATION_PREFIX + bytesToBase64Url(bytes);
}

/**
 * Parses and verifies an invitation. Rejects bad signatures, expired
 * invitations, and malformed input. Does NOT decide whether the sender is
 * a known contact — that is the caller's job.
 */
export async function decodeInvitation(rawPayload: string, now = Date.now()): Promise<Invitation> {
  const payload = normalizePayload(rawPayload);
  if (!payload.startsWith(INVITATION_PREFIX)) {
    throw new InvitationError("Not a P2P invitation.", "MALFORMED");
  }
  let body: Uint8Array;
  try {
    body = base64UrlToBytes(payload.slice(INVITATION_PREFIX.length));
  } catch {
    throw new InvitationError("Invitation is not valid base64url.", "MALFORMED");
  }
  if (body.length < 2 || body[0] !== VERSION) {
    throw new InvitationError("Unsupported invitation version.", "MALFORMED");
  }
  let kind: InvitationKind;
  if (body[1] === KIND_OFFER) kind = "offer";
  else if (body[1] === KIND_ANSWER) kind = "answer";
  else throw new InvitationError("Unknown invitation kind.", "MALFORMED");

  const hLen = headerLength(kind);
  if (body.length < hLen + SIG_LEN + 1) {
    throw new InvitationError("Invitation is truncated.", "MALFORMED");
  }

  const header = body.slice(0, hLen);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const publicKey = header.slice(OFF_IDENTITY, OFF_IDENTITY + KEY_LEN);
  const ephemeralPublicKey = header.slice(OFF_EPHEMERAL, OFF_EPHEMERAL + KEY_LEN);
  const nonce = header.slice(OFF_NONCE, OFF_NONCE + NONCE_LEN);
  const expiresAt = view.getUint16(OFF_EXPIRY) * 2 ** 32 + view.getUint32(OFF_EXPIRY + 2);
  const answersNonce = kind === "answer" ? header.slice(OFF_ANSWERS, OFF_ANSWERS + NONCE_LEN) : undefined;
  const signature = body.slice(hLen, hLen + SIG_LEN);

  let sdpBytes: Uint8Array;
  try {
    sdpBytes = await inflateRaw(body.slice(hLen + SIG_LEN), MAX_SDP_BYTES);
  } catch (e) {
    throw new InvitationError(
      e instanceof Error ? e.message : "Could not decompress SDP.",
      "MALFORMED",
    );
  }

  if (!verify(signature, signedMessage(header, sdpBytes), publicKey)) {
    throw new InvitationError("Invitation signature is invalid.", "BAD_SIGNATURE");
  }
  if (expiresAt <= now) {
    throw new InvitationError("Invitation has expired. Ask for a new one.", "EXPIRED");
  }

  return {
    kind,
    publicKey,
    ephemeralPublicKey,
    nonce,
    expiresAt,
    answersNonce,
    sdp: new TextDecoder().decode(sdpBytes),
    signature,
  };
}

export function assertKind(inv: Invitation, expected: InvitationKind): void {
  if (inv.kind !== expected) {
    throw new InvitationError(`Expected an ${expected} invitation, got ${inv.kind}.`, "WRONG_KIND");
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
