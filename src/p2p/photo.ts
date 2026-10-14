/**
 * Photo transfer inside the existing end-to-end encrypted session.
 *
 * A photo is split into small frames. Every frame is an ordinary application
 * message: it is sealed by SecureSession like any text, so a photo gets the
 * same encryption, ordering and replay protection as a chat message. Frames
 * start with the control character \u0001, which a typed message cannot
 * contain (the sender strips it), so photo frames are never mistaken for text.
 *
 *   header: \u0001P|<id>|<mime>|<size in bytes>|<chunk count>
 *   chunk:  \u0001D|<id>|<index>|<base64url data>
 *
 * The receiver accepts one transfer at a time, in order, and checks the size,
 * the chunk lengths and the file signature before showing anything.
 */
import { base64UrlToBytes, bytesToBase64Url } from "./encoding";

export const FRAME_MARK = "\u0001";
/** Multiple of 3 so base64 chunks need no padding in the middle. */
export const CHUNK_BYTES = 2400;
export const MAX_PHOTO_BYTES = 1_000_000;
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoMime = (typeof ALLOWED_MIME)[number];

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function chunkCount(size: number): number {
  return Math.ceil(size / CHUNK_BYTES);
}

/** Removes the frame marker so typed text can never impersonate a photo frame. */
export function sanitizeText(text: string): string {
  return text.split(FRAME_MARK).join("");
}

export function sniffMime(bytes: Uint8Array): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function toStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function toDataUrl(bytes: Uint8Array, mime: PhotoMime): string {
  return `data:${mime};base64,${toStandardBase64(bytes)}`;
}

/** Splits a photo into the plaintext frames to seal and send, in order. */
export function buildPhotoFrames(bytes: Uint8Array, mime: PhotoMime): string[] {
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) {
    throw new Error("Снимката е прекалено голяма.");
  }
  if (sniffMime(bytes) !== mime) throw new Error("Файлът не е валидна снимка.");
  const id = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(8)));
  const total = chunkCount(bytes.length);
  const frames = [`${FRAME_MARK}P|${id}|${mime}|${bytes.length}|${total}`];
  for (let i = 0; i < total; i++) {
    const part = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    frames.push(`${FRAME_MARK}D|${id}|${i}|${bytesToBase64Url(part)}`);
  }
  return frames;
}

export type ReceiveResult =
  | { kind: "text"; text: string }
  | { kind: "progress"; received: number; total: number }
  | { kind: "photo"; dataUrl: string; mime: PhotoMime; size: number }
  | { kind: "rejected"; reason: string };

interface Transfer {
  id: string;
  mime: PhotoMime;
  size: number;
  total: number;
  parts: Uint8Array[];
}

export class PhotoReceiver {
  private transfer: Transfer | null = null;

  /** Feeds one decrypted plaintext. Text passes through; photo frames are assembled. */
  feed(plaintext: string): ReceiveResult {
    if (!plaintext.startsWith(FRAME_MARK)) return { kind: "text", text: plaintext };
    const [type, ...rest] = plaintext.slice(1).split("|");
    if (type === "P") return this.onHeader(rest);
    if (type === "D") return this.onChunk(rest);
    return this.reject("Непознат тип съобщение.");
  }

  private reject(reason: string): ReceiveResult {
    this.transfer = null;
    return { kind: "rejected", reason };
  }

  private onHeader(f: string[]): ReceiveResult {
    if (f.length !== 4) return this.reject("Повредена снимка.");
    const [id, mime, sizeText, totalText] = f;
    const size = Number(sizeText);
    const total = Number(totalText);
    if (!ID_RE.test(id)) return this.reject("Повредена снимка.");
    if (!(ALLOWED_MIME as readonly string[]).includes(mime)) return this.reject("Неподдържан формат на снимката.");
    if (!Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) {
      return this.reject("Снимката е прекалено голяма.");
    }
    if (!Number.isInteger(total) || total !== chunkCount(size)) return this.reject("Повредена снимка.");
    this.transfer = { id, mime: mime as PhotoMime, size, total, parts: [] };
    return { kind: "progress", received: 0, total };
  }

  private onChunk(f: string[]): ReceiveResult {
    const t = this.transfer;
    if (!t || f.length !== 3) return this.reject("Неочаквана част от снимка.");
    const [id, indexText, data] = f;
    const index = Number(indexText);
    if (id !== t.id || index !== t.parts.length) return this.reject("Частите на снимката са в грешен ред.");
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(data);
    } catch {
      return this.reject("Повредена снимка.");
    }
    const last = index === t.total - 1;
    const expected = last ? t.size - CHUNK_BYTES * (t.total - 1) : CHUNK_BYTES;
    if (bytes.length !== expected) return this.reject("Повредена снимка.");
    t.parts.push(bytes);
    if (!last) return { kind: "progress", received: t.parts.length, total: t.total };

    const whole = new Uint8Array(t.size);
    let offset = 0;
    for (const p of t.parts) {
      whole.set(p, offset);
      offset += p.length;
    }
    this.transfer = null;
    if (sniffMime(whole) !== t.mime) return { kind: "rejected", reason: "Файлът не е валидна снимка." };
    return { kind: "photo", dataUrl: toDataUrl(whole, t.mime), mime: t.mime, size: t.size };
  }
}
