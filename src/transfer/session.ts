/**
 * Key agreement and framing of the device transfer.
 *
 *   shared     = X25519(own ephemeral secret, peer ephemeral public)     (existing @noble/curves)
 *   transcript = SHA-256(domain | nonce | expiry | offerKey | answerKey | SHA-256(offerSdp) | SHA-256(answerSdp))
 *   okm        = HKDF-SHA-256(shared, salt = transcript, info = domain, 96 bytes)
 *                -> key offer->answer (32), key answer->offer (32), SAS material (32)
 *
 * Both SDPs are in the transcript: they carry the DTLS fingerprints, so a changed SDP (someone
 * putting their own WebRTC endpoint in the middle) gives different keys on the two sides.
 *
 * Frames are AES-256-GCM (existing cipherSuite.ts). A direction has its own key and a strict
 * counter: the nonce is the counter, the associated data holds transcript, direction and
 * counter. A frame replayed, dropped, reordered or sent to the wrong direction does not open.
 * No AEAD primitive here is new; only the wiring is.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { aeadOpen, aeadSeal } from "../p2p/cipherSuite";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import { TransferError, type TransferPacket } from "./packet";

export type TransferRole = "sender" | "receiver";

const enc = new TextEncoder();
const DOMAIN = enc.encode("p2p-messenger/device-transfer/v1");
const AAD_DOMAIN = enc.encode("p2p-messenger/device-transfer/frame/v1");
export const SAS_WORD_COUNT = 6;
/** Largest frame accepted: the largest bundle (bundle.ts, MAX_BUNDLE_BYTES) after both base64 layers fits. */
export const MAX_FRAME_CHARS = 256 * 1024;

export interface TransferKeys {
  role: TransferRole;
  /** Key for frames the SENDER (old device) writes. */
  keySenderToReceiver: Uint8Array;
  /** Key for frames the RECEIVER (new device) writes. */
  keyReceiverToSender: Uint8Array;
  transcript: Uint8Array;
  sasWords: string[];
  expiresAt: number;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u48(n: number): Uint8Array {
  const out = new Uint8Array(6);
  const view = new DataView(out.buffer);
  view.setUint16(0, Math.floor(n / 2 ** 32));
  view.setUint32(2, n >>> 0);
  return out;
}

/** 6 words x 11 bits = 66 bits, read from the first 9 bytes (72 bits) of the SAS material. */
export function sasWordsFrom(material: Uint8Array): string[] {
  let bits = 0n;
  for (let i = 0; i < 9; i++) bits = (bits << 8n) | BigInt(material[i]);
  const words: string[] = [];
  for (let i = 0; i < SAS_WORD_COUNT; i++) {
    const shift = BigInt(72 - 11 * (i + 1));
    words.push(wordlist[Number((bits >> shift) & 0x7ffn)]);
  }
  return words;
}

/**
 * Derives the session keys. `mine` is this device's packet and secret, `theirs` the peer's packet.
 * The offer is always the sender's (old device) packet.
 */
export function deriveTransferKeys(
  role: TransferRole,
  mySecretKey: Uint8Array,
  offer: TransferPacket,
  answer: TransferPacket,
): TransferKeys {
  if (offer.kind !== "offer" || answer.kind !== "answer") {
    throw new TransferError("Грешен вид код.", "WRONG_KIND");
  }
  if (offer.nonce.length !== answer.nonce.length || !offer.nonce.every((b, i) => b === answer.nonce[i])) {
    throw new TransferError("Отговорът не е за тази покана.", "WRONG_NONCE");
  }
  const peerPublic = role === "sender" ? answer.ephemeralPublicKey : offer.ephemeralPublicKey;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(mySecretKey, peerPublic);
  } catch {
    throw new TransferError("Невалиден ключ.", "BAD_KEY");
  }
  if (shared.every((b) => b === 0)) throw new TransferError("Невалиден ключ.", "BAD_KEY");

  const transcript = sha256(
    concat(
      DOMAIN,
      offer.nonce,
      u48(offer.expiresAt),
      offer.ephemeralPublicKey,
      answer.ephemeralPublicKey,
      sha256(enc.encode(offer.sdp)),
      sha256(enc.encode(answer.sdp)),
    ),
  );
  const okm = hkdf(sha256, shared, transcript, DOMAIN, 96);
  return {
    role,
    keySenderToReceiver: okm.slice(0, 32),
    keyReceiverToSender: okm.slice(32, 64),
    transcript,
    sasWords: sasWordsFrom(okm.slice(64, 96)),
    expiresAt: offer.expiresAt,
  };
}

function frameParams(keys: TransferKeys, writer: TransferRole, seq: number) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
  const dir = new Uint8Array([writer === "sender" ? 0x01 : 0x02]);
  const seqBytes = new Uint8Array(8);
  new DataView(seqBytes.buffer).setBigUint64(0, BigInt(seq));
  return {
    iv,
    aad: concat(AAD_DOMAIN, keys.transcript, dir, seqBytes),
    key: writer === "sender" ? keys.keySenderToReceiver : keys.keyReceiverToSender,
  };
}

export type FrameMessage =
  | { t: "hello" }
  | { t: "sas-ok" }
  | { t: "bundle"; d: string }
  | { t: "stored"; did: string }
  | { t: "failed" }
  | { t: "abort" }
  /** Sender, after the bundle left: "I stop waiting for your ack". Does not void the bundle. */
  | { t: "gone" };

const FRAME_TYPES = new Set(["hello", "sas-ok", "bundle", "stored", "failed", "abort", "gone"]);

export async function sealFrame(keys: TransferKeys, seq: number, msg: FrameMessage): Promise<string> {
  const { iv, aad, key } = frameParams(keys, keys.role, seq);
  const ct = await aeadSeal("aes-256-gcm", key, iv, aad, enc.encode(JSON.stringify(msg)));
  return JSON.stringify({ p2pt: 1, n: seq, c: bytesToBase64Url(ct) });
}

/** Opens the frame the PEER wrote. `seq` is the counter this side expects next. */
export async function openFrame(keys: TransferKeys, seq: number, text: string): Promise<FrameMessage> {
  const tampered = () => new TransferError("Връзката е подправена или повредена. Прекратено.", "TAMPERED");
  if (text.length > MAX_FRAME_CHARS) throw tampered();
  try {
    const wire = JSON.parse(text) as { p2pt?: unknown; n?: unknown; c?: unknown };
    if (wire.p2pt !== 1 || wire.n !== seq || typeof wire.c !== "string") throw tampered();
    const peer: TransferRole = keys.role === "sender" ? "receiver" : "sender";
    const { iv, aad, key } = frameParams(keys, peer, seq);
    const pt = await aeadOpen("aes-256-gcm", key, iv, aad, base64UrlToBytes(wire.c));
    const msg = JSON.parse(new TextDecoder().decode(pt)) as FrameMessage;
    if (!msg || typeof msg.t !== "string" || !FRAME_TYPES.has(msg.t)) throw tampered();
    return msg;
  } catch (err) {
    throw err instanceof TransferError ? err : tampered();
  }
}
