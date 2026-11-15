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
 *      resume:  \u0001R|{"id","next"} (receiver, on a new link: send again from chunk `next`)
 *      waiting: \u0001W|<id>        (sender, on a new link: "I still have this file")
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
 * Resume: when the link drops in the middle of an accepted file, both sides keep the transfer
 * in memory (FileResumeStore, per contact, for RESUME_TTL_MS). On the next link with the same
 * contact the receiver asks for the rest with "R" (and again when the sender's "W" arrives:
 * whichever side opens the chat first may miss the other's first frame, so both speak); the
 * sender streams from that chunk on, ignoring a repeated "R", with
 * the same per-file key. Sending a chunk again gives the same IV, the same plaintext and the
 * same associated data, so the ciphertext is byte-for-byte the same: no nonce is reused for
 * different data. Nothing of a parked transfer is written to disk, and locking the app
 * forgets every parked transfer (clear()).
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
/** An interrupted transfer waits this long for the next link with the same contact. */
export const RESUME_TTL_MS = 30 * 60 * 1000;
/** On a new link, the sender waits this long for the receiver to ask for the rest. */
export const RESUME_WAIT_MS = 2 * 60 * 1000;
/** Shown when a dropped link pauses a transfer (the UI translates it). */
export const PAUSED_REASON = "Връзката прекъсна. Файлът ще продължи при следващото свързване.";

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
  /** True when the transfer is only paused: it continues on the next link. */
  readonly paused: boolean;
  constructor(message: string, paused = false) {
    super(message);
    this.name = "FileTransferError";
    this.paused = paused;
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
  return ["F|", "A|", "X|", "R|", "W|"].some((p) => plaintext.startsWith(FRAME_MARK + p));
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
  /** Our file reached the other side completely (also one that resumed on a later link). */
  sent(meta: FileMeta, blob: Blob): void;
  /** The link dropped; the transfer waits for the next link with this contact (optional). */
  paused?(meta: FileMeta, done: number, direction: "in" | "out"): void;
  /** A paused transfer is back on this link (optional). */
  resumed?(meta: FileMeta, done: number, direction: "in" | "out"): void;
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
  /** Accepted by the receiver: from then on a dropped link parks it instead of failing it. */
  streaming: boolean;
  /** Next chunk to send. */
  next: number;
}

/** The part of a sending transfer that survives a dropped link. */
interface ParkedOut {
  meta: FileMeta;
  rawId: Uint8Array;
  key: Uint8Array;
  blob: Blob;
  next: number;
}

/** The part of a receiving transfer that survives a dropped link. */
interface ParkedIn {
  meta: FileMeta;
  rawId: Uint8Array;
  key: Uint8Array;
  total: number;
  next: number;
  parts: Uint8Array[];
  hash: ReturnType<typeof sha256.create>;
}

interface ParkedEntry {
  out: ParkedOut[];
  inc: ParkedIn[];
  at: number;
}

/**
 * Interrupted transfers, in memory only, per contact (its did). A FileTransfers on a link
 * parks into it on close() and takes from it on resume(). Entries older than RESUME_TTL_MS are
 * dropped, and clear() (on lock or wipe) forgets everything and zeroes the keys.
 */
export class FileResumeStore {
  private readonly byPeer = new Map<string, ParkedEntry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  park(peer: string, out: ParkedOut[], inc: ParkedIn[]): void {
    if (out.length === 0 && inc.length === 0) return;
    const e = this.byPeer.get(peer) ?? { out: [], inc: [], at: 0 };
    e.out.push(...out);
    e.inc.push(...inc);
    e.at = this.now();
    this.byPeer.set(peer, e);
  }

  take(peer: string): { out: ParkedOut[]; inc: ParkedIn[] } {
    const e = this.byPeer.get(peer);
    this.byPeer.delete(peer);
    if (!e) return { out: [], inc: [] };
    if (this.now() - e.at > RESUME_TTL_MS) {
      forget(e);
      return { out: [], inc: [] };
    }
    return { out: e.out, inc: e.inc };
  }

  /** How many transfers wait for this contact. */
  count(peer: string): number {
    const e = this.byPeer.get(peer);
    return e && this.now() - e.at <= RESUME_TTL_MS ? e.out.length + e.inc.length : 0;
  }

  /** Forgets one contact's parked transfers (its chat was wiped). */
  drop(peer: string): void {
    const e = this.byPeer.get(peer);
    this.byPeer.delete(peer);
    if (e) forget(e);
  }

  /** Forgets one parked transfer (the person pressed "Stop" on a paused file). */
  dropTransfer(peer: string, id: string): void {
    const e = this.byPeer.get(peer);
    if (!e) return;
    forget({ out: e.out.filter((o) => o.meta.id === id), inc: e.inc.filter((i) => i.meta.id === id), at: 0 });
    e.out = e.out.filter((o) => o.meta.id !== id);
    e.inc = e.inc.filter((i) => i.meta.id !== id);
    if (e.out.length + e.inc.length === 0) this.byPeer.delete(peer);
  }

  clear(): void {
    for (const e of this.byPeer.values()) forget(e);
    this.byPeer.clear();
  }
}

function forget(e: ParkedEntry): void {
  for (const o of e.out) o.key.fill(0);
  for (const i of e.inc) {
    i.key.fill(0);
    i.parts = [];
  }
}

/** The app's store: one per page, emptied on lock (App.tsx). */
export const parkedFiles = new FileResumeStore();

export interface ResumeOptions {
  store: FileResumeStore;
  /** The contact's did: transfers park and resume per contact. */
  peer: string;
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
  /** Taken from the resume store: a "W" from the sender may ask for the rest again. */
  resumed?: boolean;
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
  private readonly resumeOpts: ResumeOptions | null;
  /** Taken from the store on resume(): waiting for the receiver's "R". */
  private readonly waiting = new Map<string, ParkedOut & { timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  /** Without `resume`, a dropped link fails every transfer (groups). */
  constructor(transport: FileTransport, events: FileEvents, maxBytes = MAX_FILE_BYTES, resume?: ResumeOptions) {
    this.transport = transport;
    this.events = events;
    this.maxBytes = maxBytes;
    this.resumeOpts = resume ?? null;
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
      this.out.set(id, { meta, rawId: raw, key, blob, resolveAccept: resolve, cancelled: false, timer, streaming: false, next: 0 });
    });
    const offer = { ...meta, key: bytesToBase64Url(key), n: chunkCount(blob.size) };
    await this.transport.sendControl(`${FRAME_MARK}F|${JSON.stringify(offer)}`);
    this.events.outgoing?.(meta);
    if (!(await accepted)) throw new FileTransferError("Файлът не беше приет.");
    await this.stream(id);
    return meta;
  }

  /**
   * Call once the new link is up: picks up the transfers that the last link with this contact
   * left unfinished. The receiver asks for the rest; the sender waits for that request.
   */
  async resume(): Promise<void> {
    if (!this.resumeOpts || this.closed) return;
    const { out, inc } = this.resumeOpts.store.take(this.resumeOpts.peer);
    for (const o of out) {
      const timer = setTimeout(() => {
        const w = this.waiting.get(o.meta.id);
        if (!w) return;
        this.waiting.delete(o.meta.id);
        w.key.fill(0);
        this.events.failed(o.meta.id, "Получателят не продължи файла.", "out");
      }, RESUME_WAIT_MS);
      this.waiting.set(o.meta.id, { ...o, timer });
      this.events.resumed?.(o.meta, Math.min(o.meta.size, o.next * CHUNK_BYTES), "out");
      try {
        await this.transport.sendControl(`${FRAME_MARK}W|${o.meta.id}`);
      } catch {
        // The new link is already gone: close() parks it again.
      }
    }
    for (const p of inc) {
      this.inc.set(p.meta.id, {
        ...p,
        accepted: true,
        cryptoKey: importKey(p.key, "decrypt"),
        queue: Promise.resolve(),
        resumed: true,
      });
      this.events.resumed?.(p.meta, Math.min(p.meta.size, p.next * CHUNK_BYTES), "in");
      await this.askRest(p.meta.id);
    }
  }

  /** Receiver: asks the sender for the chunks from `next` on. */
  private async askRest(id: string): Promise<void> {
    const t = this.inc.get(id);
    if (!t || this.closed) return;
    try {
      await this.transport.sendControl(`${FRAME_MARK}R|${JSON.stringify({ id, next: t.next })}`);
    } catch {
      // The new link is already gone: close() parks it again.
    }
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
    const known = this.inc.has(id) || this.out.has(id) || this.waiting.has(id);
    if (this.inc.has(id)) this.failIn(id, "Отказано.");
    if (this.out.has(id)) this.abortOut(id, "Отказано.");
    this.dropWaiting(id, "Отказано.");
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
    else if (type === "R") this.onResume(body);
    else if (type === "W") this.onPaused(body);
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

  /**
   * The link went away. With resume options, accepted transfers are parked for the next link
   * with this contact; offers nobody accepted yet end, as without them.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const parkOut: ParkedOut[] = [];
    const parkIn: ParkedIn[] = [];
    if (this.resumeOpts) {
      for (const [id, t] of [...this.out]) {
        if (!t.streaming || t.cancelled) continue;
        this.out.delete(id);
        t.cancelled = true; // the running stream() loop stops at its next chunk
        clearTimeout(t.timer);
        parkOut.push({ meta: t.meta, rawId: t.rawId, key: t.key, blob: t.blob, next: t.next });
        this.events.paused?.(t.meta, Math.min(t.meta.size, t.next * CHUNK_BYTES), "out");
      }
      for (const [id, w] of [...this.waiting]) {
        this.waiting.delete(id);
        clearTimeout(w.timer);
        parkOut.push({ meta: w.meta, rawId: w.rawId, key: w.key, blob: w.blob, next: w.next });
        this.events.paused?.(w.meta, Math.min(w.meta.size, w.next * CHUNK_BYTES), "out");
      }
      for (const [id, t] of [...this.inc]) {
        if (!t.accepted) continue;
        this.inc.delete(id);
        parkIn.push({ meta: t.meta, rawId: t.rawId, key: t.key, total: t.total, next: t.next, parts: t.parts, hash: t.hash });
        this.events.paused?.(t.meta, Math.min(t.meta.size, t.next * CHUNK_BYTES), "in");
      }
      this.resumeOpts.store.park(this.resumeOpts.peer, parkOut, parkIn);
    }
    for (const id of [...this.out.keys()]) this.abortOut(id, "Връзката прекъсна.");
    for (const id of [...this.inc.keys()]) this.failIn(id, "Връзката прекъсна.");
    for (const id of [...this.waiting.keys()]) this.dropWaiting(id, "Връзката прекъсна.");
  }

  // ------------------------------------------------------------------------------ sending

  private async stream(id: string): Promise<void> {
    const t = this.out.get(id);
    if (!t) throw new FileTransferError("Изпращането е спряно.");
    t.streaming = true;
    const key = await importKey(t.key, "encrypt");
    const total = chunkCount(t.meta.size);
    for (let i = t.next; i < total; i++) {
      if (t.cancelled || this.closed) throw this.stopped(t);
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
      try {
        await this.transport.sendBinary(msg);
      } catch (err) {
        // The link is gone. With resume options the owner's close() parks this transfer.
        if (this.resumeOpts) throw new FileTransferError(PAUSED_REASON, true);
        throw err;
      }
      t.next = i + 1;
      this.events.progress(id, Math.min(t.meta.size, (i + 1) * CHUNK_BYTES), t.meta.size, "out");
    }
    clearTimeout(t.timer);
    this.out.delete(id);
    t.key.fill(0);
    this.events.sent(t.meta, t.blob);
  }

  /** Why a stream loop stopped: paused (parked by close()) or really stopped. */
  private stopped(t: Outgoing): FileTransferError {
    const parked = this.resumeOpts !== null && t.streaming && !this.out.has(t.meta.id);
    return parked ? new FileTransferError(PAUSED_REASON, true) : new FileTransferError("Изпращането е спряно.");
  }

  /** Sender, on a new link: the receiver asks for the rest of a parked file. */
  private onResume(json: string): void {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const { id, next } = o;
    if (typeof id !== "string" || !ID_RE.test(id)) return;
    // A repeated request (the receiver also answers our "W"): the file is already streaming.
    if (this.out.has(id)) return;
    const w = this.waiting.get(id);
    if (!w) {
      // Nothing to continue (the app restarted, or the offer is gone): end it on their side.
      if (!this.closed) void Promise.resolve(this.transport.sendControl(`${FRAME_MARK}X|${id}`)).catch(() => undefined);
      return;
    }
    const total = chunkCount(w.meta.size);
    if (typeof next !== "number" || !Number.isInteger(next) || next < 0 || next >= total) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    const timer = setTimeout(() => undefined, 0);
    this.out.set(id, {
      meta: w.meta,
      rawId: w.rawId,
      key: w.key,
      blob: w.blob,
      resolveAccept: () => undefined,
      cancelled: false,
      timer,
      streaming: true,
      next,
    });
    this.stream(id).catch((err: unknown) => {
      if (err instanceof FileTransferError && err.paused) return;
      this.abortOut(id, err instanceof Error ? err.message : "Изпращането е спряно.");
    });
  }

  /**
   * Receiver: the sender still has a paused file; ask for the rest. An unknown id is ignored
   * (this side may not have resumed yet); the sender gives up after RESUME_WAIT_MS.
   */
  private onPaused(id: string): void {
    if (!ID_RE.test(id)) return;
    if (this.inc.get(id)?.resumed) void this.askRest(id);
  }

  private dropWaiting(id: string, reason: string): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.key.fill(0);
    this.events.failed(id, reason, "out");
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
    this.dropWaiting(id, "Получателят отказа файла.");
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
    // The link may have closed while this chunk was decrypting: then the transfer is parked
    // with the state from before this chunk, and the chunk is asked for again on resume.
    if (this.inc.get(t.meta.id) !== t) return;
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
