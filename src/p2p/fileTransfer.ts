/**
 * File transfer over a direct link, for any file up to a size limit (100 MB in a 1:1 chat,
 * 50 MB in a group). No server stores anything: the bytes go straight to the other device.
 *
 * Two kinds of traffic:
 *
 *  - Control frames travel inside the existing encrypted session (SecureSession, Double
 *    Ratchet), like any chat message. They start with \u0001 so typed text can never pose as
 *    one (photo.ts strips that character from text).
 *
 *      offer:   \u0001F|{"id","name","size","mime","sha256","key","n"}
 *      accept:  \u0001A|<id>
 *      cancel:  \u0001X|<id>        (decline by the receiver, or abort by either side)
 *
 *    The offer carries a fresh random AES-256-GCM key for this one file. Only the peer that
 *    holds the session can read it, so a group member who joins later never gets it.
 *
 *  - Chunks travel as binary data-channel messages, after the receiver accepts:
 *
 *      [0xF1][id: 8 bytes][index: uint32 BE][AES-GCM ciphertext of up to CHUNK_BYTES]
 *
 *    The IV is id || index (unique per chunk under a key used for one file only), and the
 *    13-byte header is the associated data, so a chunk cannot be moved to another file or
 *    position. The receiver takes chunks strictly in order, checks every length, and at the
 *    end compares the SHA-256 of the whole file with the one in the offer.
 *
 * Crypto is WebCrypto AES-GCM and @noble/hashes SHA-256: no custom primitives.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { asBufferSource } from "../identity/bufferUtils";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding";
import { FRAME_MARK } from "./photo";

/** 60 KiB: with the 13-byte header and the 16-byte tag a chunk stays under the 64 KiB
 *  data-channel message size that every browser accepts. */
export const CHUNK_BYTES = 60 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_GROUP_FILE_BYTES = 50 * 1024 * 1024;
/** Files up to this size are kept (encrypted) in the chat history; larger ones are not. */
export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024;
/** An offer that nobody answers is withdrawn after this long. */
export const OFFER_TIMEOUT_MS = 10 * 60 * 1000;

const CHUNK_MAGIC = 0xf1;
const HEADER_BYTES = 13;
const TAG_BYTES = 16;
const ID_BYTES = 8;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_NAME_CHARS = 120;

/** Shown inline only when the bytes really are this type; everything else is a download. */
export const INLINE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "audio/flac", "audio/mp4", "audio/aac"] as const;
export type InlineMime = (typeof INLINE_MIME)[number];
export const DOWNLOAD_MIME = "application/octet-stream";

export interface FileMeta {
  id: string;
  /** Display name, cleaned of paths and control characters. */
  name: string;
  size: number;
  /** One of INLINE_MIME after sniffing, or DOWNLOAD_MIME. Never text/html or image/svg+xml. */
  mime: string;
  /** SHA-256 of the whole file, base64url. */
  sha256: string;
}

export class FileTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTransferError";
  }
}

// ---------------------------------------------------------------------------------- helpers

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_BYTES));
}

/** Keeps only a plain file name: no folders, no control characters, a sane length. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // Control characters, Windows-reserved characters, and bidi controls (U+202A–U+202E,
  // U+2066–U+2069): "photo\u202egpj.exe" would otherwise display as "photoexe.jpg".
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "").replace(/^\.+/, "").trim();
  const short = [...clean].slice(0, MAX_NAME_CHARS).join("");
  return short || "файл";
}

/** The real type of the first bytes, if it is one we show inline. */
export function sniffInlineMime(head: Uint8Array): InlineMime | null {
  const b = head;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) return "image/png";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") return ascii(8, 12) === "M4A " || ascii(8, 12) === "M4B " ? "audio/mp4" : "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (b.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (b.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  // MPEG audio frame sync: 11 set bits. Layer bits 00 mean AAC (ADTS), anything else MP3.
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0x06) === 0 ? "audio/aac" : "audio/mpeg";
  return null;
}

function newId(): { id: string; raw: Uint8Array } {
  const raw = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  return { id: bytesToBase64Url(raw), raw };
}

function header(rawId: Uint8Array, index: number): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES);
  h[0] = CHUNK_MAGIC;
  h.set(rawId, 1);
  new DataView(h.buffer).setUint32(1 + ID_BYTES, index, false);
  return h;
}

function iv(rawId: Uint8Array, index: number): Uint8Array {
  const v = new Uint8Array(12);
  v.set(rawId, 0);
  new DataView(v.buffer).setUint32(ID_BYTES, index, false);
  return v;
}

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(raw), "AES-GCM", false, [usage]);
}

/** SHA-256 of a Blob, read in slices so a 100 MB file never sits in memory twice. */
export async function hashBlob(blob: Blob): Promise<string> {
  const h = sha256.create();
  for (let off = 0; off < blob.size; off += 4 * 1024 * 1024) {
    h.update(new Uint8Array(await blob.slice(off, off + 4 * 1024 * 1024).arrayBuffer()));
  }
  return bytesToBase64Url(h.digest());
}

/** Is this decrypted plaintext a file control frame? */
export function isFileFrame(plaintext: string): boolean {
  return plaintext.startsWith(FRAME_MARK + "F|") || plaintext.startsWith(FRAME_MARK + "A|") || plaintext.startsWith(FRAME_MARK + "X|");
}

/** Is this binary message a file chunk? */
export function isFileChunk(bytes: Uint8Array): boolean {
  return bytes.length > HEADER_BYTES && bytes[0] === CHUNK_MAGIC;
}

// ---------------------------------------------------------------------------------- transport

/** What a transfer needs from a link. */
export interface FileTransport {
  /** Seals and sends a control frame inside the encrypted session. */
  sendControl(plaintext: string): Promise<void> | void;
  /** Sends a binary message; resolves once the link can take more (back-pressure). */
  sendBinary(bytes: Uint8Array): Promise<void>;
}

export interface FileEvents {
  /** The other side offers a file; call accept(id) or decline(id). */
  offered(meta: FileMeta): void;
  /** Our offer went out and waits for the other side (optional). */
  outgoing?(meta: FileMeta): void;
  /** Bytes sent or received so far for a transfer. */
  progress(id: string, done: number, total: number, direction: "in" | "out"): void;
  /** A received file passed every check. */
  received(meta: FileMeta, blob: Blob): void;
  /** Our file reached the other side completely. */
  sent(meta: FileMeta): void;
  /** A transfer ended without a file: declined, cancelled, too big, damaged, closed. */
  failed(id: string, reason: string, direction: "in" | "out"): void;
}

interface Outgoing {
  meta: FileMeta;
  rawId: Uint8Array;
  key: Uint8Array;
  blob: Blob;
  resolveAccept: (ok: boolean) => void;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface Incoming {
  meta: FileMeta;
  rawId: Uint8Array;
  key: Uint8Array;
  total: number;
  next: number;
  parts: Uint8Array[];
  hash: ReturnType<typeof sha256.create>;
  accepted: boolean;
  cryptoKey: Promise<CryptoKey> | null;
  /** Chunks are decrypted one after another, in arrival order. */
  queue: Promise<void>;
}

/**
 * All file transfers on one link (one contact, or one group member). Feed it the control
 * frames and binary chunks that arrive on the link; it calls the events.
 */
export class FileTransfers {
  private readonly out = new Map<string, Outgoing>();
  private readonly inc = new Map<string, Incoming>();
  private readonly transport: FileTransport;
  private readonly events: FileEvents;
  private readonly maxBytes: number;
  private closed = false;

  constructor(transport: FileTransport, events: FileEvents, maxBytes = MAX_FILE_BYTES) {
    this.transport = transport;
    this.events = events;
    this.maxBytes = maxBytes;
  }

  get limit(): number {
    return this.maxBytes;
  }

  /**
   * Offers a file and, once accepted, streams it. Resolves with the metadata when the last
   * chunk is sent; rejects if the other side declines, the offer times out or it is too big.
   */
  async send(blob: Blob, name: string): Promise<FileMeta> {
    if (this.closed) throw new FileTransferError("Връзката е затворена.");
    if (blob.size < 1) throw new FileTransferError("Файлът е празен.");
    if (blob.size > this.maxBytes) throw new FileTransferError("Файлът е твърде голям.");
    const { id, raw } = newId();
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const meta: FileMeta = {
      id,
      name: cleanFileName(name),
      size: blob.size,
      mime: sniffInlineMime(head) ?? DOWNLOAD_MIME,
      sha256: await hashBlob(blob),
    };
    const key = crypto.getRandomValues(new Uint8Array(32));
    const accepted = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.abortOut(id, "Никой не прие файла навреме."), OFFER_TIMEOUT_MS);
      this.out.set(id, { meta, rawId: raw, key, blob, resolveAccept: resolve, cancelled: false, timer });
    });
    const offer = { ...meta, key: bytesToBase64Url(key), n: chunkCount(blob.size) };
    await this.transport.sendControl(`${FRAME_MARK}F|${JSON.stringify(offer)}`);
    this.events.outgoing?.(meta);
    if (!(await accepted)) throw new FileTransferError("Файлът не беше приет.");
    await this.stream(id);
    return meta;
  }

  /** Receiver: accepts an offered file; the chunks start to arrive. */
  async accept(id: string): Promise<void> {
    const t = this.inc.get(id);
    if (!t || t.accepted) return;
    t.accepted = true;
    t.cryptoKey = importKey(t.key, "decrypt");
    this.events.progress(id, 0, t.meta.size, "in");
    await this.transport.sendControl(`${FRAME_MARK}A|${id}`);
  }

  /** Receiver: declines an offer. Sender or receiver: stops a transfer in progress. */
  async cancel(id: string): Promise<void> {
    const known = this.inc.has(id) || this.out.has(id);
    if (this.inc.delete(id)) this.events.failed(id, "Отказано.", "in");
    if (this.out.has(id)) this.abortOut(id, "Отказано.");
    if (known && !this.closed) await this.transport.sendControl(`${FRAME_MARK}X|${id}`);
  }

  /** Feeds a decrypted control frame. Returns false if it is not a file frame. */
  handleControl(plaintext: string): boolean {
    if (!isFileFrame(plaintext)) return false;
    const type = plaintext[1];
    const body = plaintext.slice(3);
    if (type === "F") this.onOffer(body);
    else if (type === "A") this.onAccept(body);
    else if (type === "X") this.onCancel(body);
    return true;
  }

  /** Feeds a binary message. Returns false if it is not a file chunk. */
  handleBinary(bytes: Uint8Array): boolean {
    if (!isFileChunk(bytes)) return false;
    const id = bytesToBase64Url(bytes.slice(1, 1 + ID_BYTES));
    const t = this.inc.get(id);
    if (!t || !t.accepted) return true; // unknown or not accepted: dropped
    t.queue = t.queue.then(() => this.onChunk(t, bytes)).catch((err: unknown) => {
      if (!this.inc.has(id)) return;
      this.failIn(id, err instanceof Error ? err.message : "Повреден файл.");
      // Tell the sender to stop: the rest of this file would be thrown away anyway.
      if (!this.closed) void Promise.resolve(this.transport.sendControl(`${FRAME_MARK}X|${id}`)).catch(() => undefined);
    });
    return true;
  }

  /** The link went away: every transfer on it ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.out.keys()]) this.abortOut(id, "Връзката прекъсна.");
    for (const id of [...this.inc.keys()]) this.failIn(id, "Връзката прекъсна.");
  }

  // ------------------------------------------------------------------------------ sending

  private async stream(id: string): Promise<void> {
    const t = this.out.get(id);
    if (!t) throw new FileTransferError("Изпращането е спряно.");
    const key = await importKey(t.key, "encrypt");
    const total = chunkCount(t.meta.size);
    for (let i = 0; i < total; i++) {
      if (t.cancelled || this.closed) throw new FileTransferError("Изпращането е спряно.");
      const plain = new Uint8Array(await t.blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
      const h = header(t.rawId, i);
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: asBufferSource(iv(t.rawId, i)), additionalData: asBufferSource(h) },
          key,
          asBufferSource(plain),
        ),
      );
      const msg = new Uint8Array(HEADER_BYTES + ct.length);
      msg.set(h, 0);
      msg.set(ct, HEADER_BYTES);
      await this.transport.sendBinary(msg);
      this.events.progress(id, Math.min(t.meta.size, (i + 1) * CHUNK_BYTES), t.meta.size, "out");
    }
    clearTimeout(t.timer);
    this.out.delete(id);
    t.key.fill(0);
    this.events.sent(t.meta);
  }

  private onAccept(id: string): void {
    const t = this.out.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    t.resolveAccept(true);
  }

  private abortOut(id: string, reason: string): void {
    const t = this.out.get(id);
    if (!t) return;
    t.cancelled = true;
    clearTimeout(t.timer);
    this.out.delete(id);
    t.key.fill(0);
    t.resolveAccept(false);
    this.events.failed(id, reason, "out");
  }

  // ---------------------------------------------------------------------------- receiving

  private onOffer(json: string): void {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const { id, name, size, mime, sha256: hash, key, n } = o;
    if (typeof id !== "string" || !ID_RE.test(id) || this.inc.has(id)) return;
    if (typeof name !== "string" || typeof hash !== "string" || typeof key !== "string") return;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return;
    if (typeof n !== "number" || n !== chunkCount(size)) return;
    let rawKey: Uint8Array;
    let rawHash: Uint8Array;
    try {
      rawKey = base64UrlToBytes(key);
      rawHash = base64UrlToBytes(hash);
    } catch {
      return;
    }
    if (rawKey.length !== 32 || rawHash.length !== 32) return;
    const meta: FileMeta = {
      id,
      name: cleanFileName(name),
      size,
      mime: typeof mime === "string" && (INLINE_MIME as readonly string[]).includes(mime) ? mime : DOWNLOAD_MIME,
      sha256: hash,
    };
    if (size > this.maxBytes) {
      void this.transport.sendControl(`${FRAME_MARK}X|${id}`);
      this.events.failed(id, "Файлът е твърде голям.", "in");
      return;
    }
    this.inc.set(id, {
      meta,
      rawId: base64UrlToBytes(id),
      key: rawKey,
      total: n,
      next: 0,
      parts: [],
      hash: sha256.create(),
      accepted: false,
      cryptoKey: null,
      queue: Promise.resolve(),
    });
    this.events.offered(meta);
  }

  private onCancel(id: string): void {
    if (this.inc.has(id)) this.failIn(id, "Изпращачът спря файла.");
    if (this.out.has(id)) this.abortOut(id, "Получателят отказа файла.");
  }

  private async onChunk(t: Incoming, bytes: Uint8Array): Promise<void> {
    if (!this.inc.has(t.meta.id)) return;
    const h = bytes.slice(0, HEADER_BYTES);
    const index = new DataView(h.buffer).getUint32(1 + ID_BYTES, false);
    if (index !== t.next) throw new FileTransferError("Частите на файла са в грешен ред.");
    const last = index === t.total - 1;
    const plainLen = last ? t.meta.size - CHUNK_BYTES * (t.total - 1) : CHUNK_BYTES;
    if (bytes.length !== HEADER_BYTES + plainLen + TAG_BYTES) throw new FileTransferError("Повредена част от файла.");
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: asBufferSource(iv(t.rawId, index)), additionalData: asBufferSource(h) },
          await t.cryptoKey!,
          asBufferSource(bytes.slice(HEADER_BYTES)),
        ),
      );
    } catch {
      throw new FileTransferError("Част от файла не мина проверката.");
    }
    t.parts.push(plain);
    t.hash.update(plain);
    t.next++;
    this.events.progress(t.meta.id, Math.min(t.meta.size, t.next * CHUNK_BYTES), t.meta.size, "in");
    if (!last) return;

    this.inc.delete(t.meta.id);
    t.key.fill(0);
    if (bytesToBase64Url(t.hash.digest()) !== t.meta.sha256) {
      this.events.failed(t.meta.id, "Файлът не съвпада с контролната сума.", "in");
      return;
    }
    // Trust the bytes, not the sender's label: inline only when the content really is that type.
    const real = sniffInlineMime(t.parts[0].slice(0, 16));
    const meta = { ...t.meta, mime: real ?? DOWNLOAD_MIME };
    this.events.received(meta, new Blob(t.parts as BlobPart[], { type: meta.mime }));
  }

  private failIn(id: string, reason: string): void {
    const t = this.inc.get(id);
    if (!t) return;
    this.inc.delete(id);
    t.key.fill(0);
    t.parts = [];
    this.events.failed(id, reason, "in");
  }
}
