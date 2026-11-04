/**
 * PAKE-protected signaling over the Worker's relay room.
 *
 * The room id (issued by the Worker) is public; the three words are the password and never
 * leave the two devices. A CPace run over the relay turns the words into a shared secret
 * (ISK); both sides then prove they hold it (key confirmation) and only after that is
 * anything sensitive (SDP, did:key, invitation) sent, sealed with XChaCha20-Poly1305.
 * The relay therefore sees only random-looking group elements, MACs and ciphertext.
 * A wrong word fails key confirmation, and the room is never retried.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { cpaceFinish, cpaceStart } from "../p2p/cpace";
import { newPairingWords, pairingPassword, type PairingCode } from "../p2p/pairingCode";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import { isSignalingPayload, type ISignalingProvider, type PayloadHandler, type SignalingPayload } from "./types";
import { WebSocketSignalingProvider } from "./websocketProvider";

export type PakeErrorCode = "wrong_code" | "protocol" | "timeout" | "closed";

export class PakeError extends Error {
  readonly code: PakeErrorCode;
  constructor(message: string, code: PakeErrorCode) {
    super(message);
    this.name = "PakeError";
    this.code = code;
  }
}

export interface PakeOptions {
  random?: (n: number) => Uint8Array;
  /** Pairing-phase timeout in ms (default 120000). */
  timeoutMs?: number;
}

type CpaceState = ReturnType<typeof cpaceStart>["state"];

const enc = new TextEncoder();
const dec = new TextDecoder();
/** What worker/room.ts sends to the first peer when the second one joins. */
const JOINED_FRAME = '{"type":"joined"}';
const DEFAULT_TIMEOUT_MS = 120_000;

type Role = "opener" | "joiner";
type Phase = "idle" | "pairing" | "ready" | "failed";

interface Keys {
  kcOwn: Uint8Array;
  kcPeer: Uint8Array;
  encOwn: Uint8Array;
  encPeer: Uint8Array;
}

function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function derive(isk: Uint8Array, name: string): Uint8Array {
  return hkdf(sha256, isk, new Uint8Array(0), utf8(`p2p-pure/pake/${name}/v1`), 32);
}

function sessionId(room: string): Uint8Array {
  return sha512(concat(utf8("p2p-pure/pake/sid/v1"), utf8(room))).slice(0, 16);
}

function nonceFor(counter: number): Uint8Array {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(16, BigInt(counter), false);
  return n;
}

function counterOf(nonce: Uint8Array): number | null {
  if (nonce.length !== 24) return null;
  for (let i = 0; i < 16; i++) if (nonce[i] !== 0) return null;
  const big = new DataView(nonce.buffer, nonce.byteOffset, 24).getBigUint64(16, false);
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(big);
}

function parseFrame(text: string): { t: string; [k: string]: unknown } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== "string") return null;
  return o as { t: string };
}

function b64(value: unknown, expectedLen?: number): Uint8Array | null {
  if (typeof value !== "string" || value.length > 40_000 || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const bytes = base64UrlToBytes(value);
    return expectedLen !== undefined && bytes.length !== expectedLen ? null : bytes;
  } catch {
    return null;
  }
}

export class PakeSignalingProvider implements ISignalingProvider {
  private readonly inner: WebSocketSignalingProvider;
  private readonly random: (n: number) => Uint8Array;
  private readonly timeoutMs: number;

  private role: Role | null = null;
  private code: PairingCode | null = null;
  private phase: Phase = "idle";
  private cpaceState: CpaceState | null = null;
  private ownMsg: Uint8Array | null = null;
  private peerMsg: Uint8Array | null = null;
  private pakeSeen = false;
  private pakeSent = false;
  private joinedSeen = false;
  private pendingKc: Promise<void> | null = null;
  private peerKcOk = false;
  private transcript: Uint8Array | null = null;
  private keys: Keys | null = null;
  private sendCounter = 0;
  private recvCounter = 0;
  private lastError: PakeError | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offerHandlers: PayloadHandler[] = [];
  private answerHandlers: PayloadHandler[] = [];
  private errorHandlers: Array<(e: PakeError) => void> = [];
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((e: PakeError) => void) | null = null;

  constructor(inner: WebSocketSignalingProvider = new WebSocketSignalingProvider(), opts: PakeOptions = {}) {
    this.inner = inner;
    this.random = opts.random ?? randomBytes;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  /** Opener: the Worker issues the room id, the three words are generated locally. */
  async openRoom(): Promise<PairingCode> {
    this.begin("opener");
    this.inner.onRawFrame((t) => this.onFrame(t));
    this.inner.onClose(() => this.onSocketClosed());
    let room: string;
    try {
      room = await this.inner.openRoom();
    } catch (e) {
      this.abort(e);
      throw e;
    }
    const words = newPairingWords(this.random);
    const code: PairingCode = { room, words };
    this.code = code;
    this.armTimer();
    this.start();
    return code;
  }

  /** Joiner: connects to the room named in the code and starts the exchange at once. */
  async joinRoom(code: PairingCode): Promise<void> {
    this.begin("joiner");
    this.code = code;
    this.inner.onRawFrame((t) => this.onFrame(t));
    this.inner.onClose(() => this.onSocketClosed());
    try {
      await this.inner.joinRoom(code.room);
    } catch (e) {
      this.abort(e);
      throw e;
    }
    this.armTimer();
    this.start();
  }

  /** Resolves only after CPace and key confirmation (both directions) succeeded. */
  waitForPeer(): Promise<void> {
    if (!this.ready) return Promise.reject(new PakeError("Стаята не е отворена.", "closed"));
    return this.ready;
  }

  async sendOffer(payload: SignalingPayload): Promise<void> {
    if (payload.type !== "offer") throw new PakeError("Очаква се покана.", "protocol");
    await this.sendBox(payload);
  }

  async sendAnswer(payload: SignalingPayload): Promise<void> {
    if (payload.type !== "answer") throw new PakeError("Очаква се отговор.", "protocol");
    await this.sendBox(payload);
  }

  onOfferReceived(callback: PayloadHandler): void {
    this.offerHandlers.push(callback);
  }

  onAnswerReceived(callback: PayloadHandler): void {
    this.answerHandlers.push(callback);
  }

  /** Extra: errors that happen after pairing succeeded (bad box, replay). */
  onError(callback: (e: PakeError) => void): void {
    this.errorHandlers.push(callback);
  }

  disconnect(): void {
    this.clearTimer();
    this.wipe();
    this.offerHandlers = [];
    this.answerHandlers = [];
    this.errorHandlers = [];
    if (this.phase === "pairing" || this.phase === "idle") {
      this.failQuietly(new PakeError("Връзката е прекъсната.", "closed"));
    }
    this.phase = "failed";
    this.inner.disconnect();
  }

  // ---- internals ----

  private begin(role: Role): void {
    this.role = role;
    this.phase = "pairing";
    this.pakeSeen = false;
    this.pakeSent = false;
    this.joinedSeen = false;
    this.ownMsg = this.peerMsg = this.cpaceState = this.transcript = this.keys = null;
    this.pendingKc = null;
    this.peerKcOk = false;
    this.sendCounter = this.recvCounter = 0;
    this.lastError = null;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => undefined);
  }

  private start(): void {
    const code = this.code as PairingCode;
    const result = cpaceStart(
      {
        prs: pairingPassword(code),
        ci: utf8(`p2p-pure/pake/v1|${code.room}`),
        sid: sessionId(code.room),
        ad: utf8(this.role === "opener" ? "opener" : "joiner"),
      },
      this.random,
    );
    this.ownMsg = result.msg;
    this.cpaceState = result.state;
    // The opener sends only after the relay said the joiner is here; the joiner sends at once.
    if (this.role === "joiner" || this.joinedSeen) void this.sendPake();
    try {
      this.tryFinishCpace();
    } catch (e) {
      this.fail(e instanceof PakeError ? e : new PakeError("Грешка в протокола.", "protocol"));
    }
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fail(new PakeError("Времето за свързване изтече.", "timeout"));
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async sendPake(): Promise<void> {
    if (!this.ownMsg || this.pakeSent) return;
    this.pakeSent = true;
    try {
      await this.inner.sendRaw(JSON.stringify({ t: "pake", v: 1, m: bytesToBase64Url(this.ownMsg) }));
    } catch {
      this.fail(new PakeError("Връзката към стаята се прекъсна.", "closed"));
    }
  }

  private onSocketClosed(): void {
    if (this.phase === "pairing" || this.phase === "idle") {
      this.fail(new PakeError("Връзката се затвори преди сдвояването да завърши.", "closed"));
    } else if (this.phase === "ready") {
      this.phase = "failed";
      this.lastError = new PakeError("Връзката се затвори.", "closed");
      this.wipe();
    }
  }

  private abort(e: unknown): void {
    this.phase = "failed";
    this.clearTimer();
    const err = new PakeError(e instanceof Error ? e.message : "Връзката се провали.", "closed");
    this.lastError = err;
    this.rejectReady?.(err);
    this.rejectReady = this.resolveReady = null;
  }

  private failQuietly(err: PakeError): void {
    this.lastError = err;
    this.rejectReady?.(err);
    this.rejectReady = this.resolveReady = null;
  }

  private fail(err: PakeError): void {
    if (this.phase === "failed") return;
    const wasReady = this.phase === "ready";
    this.phase = "failed";
    this.clearTimer();
    this.lastError = err;
    this.wipe();
    this.rejectReady?.(err);
    this.rejectReady = this.resolveReady = null;
    if (wasReady) for (const h of [...this.errorHandlers]) h(err);
    // Never retry in the same room: close the socket for good, but let our own confirmation
    // frame out first so the peer also learns "wrong code" instead of just seeing a close.
    const close = () => this.inner.disconnect();
    if (this.pendingKc) void this.pendingKc.then(close, close);
    else close();
  }

  private wipe(): void {
    if (this.keys) {
      this.keys.kcOwn.fill(0);
      this.keys.kcPeer.fill(0);
      this.keys.encOwn.fill(0);
      this.keys.encPeer.fill(0);
    }
    this.keys = null;
    this.cpaceState = null;
  }

  private onFrame(text: string): void {
    if (this.phase === "failed") return;
    if (text === JOINED_FRAME) {
      this.joinedSeen = true;
      if (this.role === "opener" && this.ownMsg) void this.sendPake();
      return;
    }
    const frame = parseFrame(text);
    if (!frame) return;
    try {
      this.handleFrame(frame);
    } catch (e) {
      this.fail(e instanceof PakeError ? e : new PakeError("Грешка в протокола.", "protocol"));
    }
  }

  private handleFrame(frame: { t: string; [k: string]: unknown }): void {
    if (frame.v !== 1) throw new PakeError("Неподдържана версия на протокола.", "protocol");
    switch (frame.t) {
      case "pake":
        return this.onPake(frame);
      case "kc":
        return this.onKc(frame);
      case "box":
        return this.onBox(frame);
      default:
        throw new PakeError("Неочакван кадър.", "protocol");
    }
  }

  private onPake(frame: { [k: string]: unknown }): void {
    if (this.pakeSeen || this.phase !== "pairing") throw new PakeError("Повторно съобщение за сдвояване.", "protocol");
    const msg = b64(frame.m);
    if (!msg || msg.length === 0) throw new PakeError("Невалидно съобщение за сдвояване.", "protocol");
    this.pakeSeen = true;
    this.peerMsg = msg;
    this.tryFinishCpace();
  }

  private tryFinishCpace(): void {
    if (!this.ownMsg || !this.peerMsg || !this.cpaceState || this.keys) return;
    let isk: Uint8Array;
    try {
      isk = cpaceFinish(this.cpaceState, this.peerMsg, this.role === "opener" ? "initiator" : "responder");
    } catch {
      throw new PakeError("Невалидно съобщение за сдвояване.", "protocol");
    }
    this.cpaceState = null;
    const opener = this.role === "opener";
    const openerMsg = opener ? this.ownMsg : this.peerMsg;
    const joinerMsg = opener ? this.peerMsg : this.ownMsg;
    this.transcript = sha256(concat(openerMsg, joinerMsg));
    const kcO = derive(isk, "kc-opener");
    const kcJ = derive(isk, "kc-joiner");
    const eO = derive(isk, "enc-opener");
    const eJ = derive(isk, "enc-joiner");
    isk.fill(0);
    this.keys = opener
      ? { kcOwn: kcO, kcPeer: kcJ, encOwn: eO, encPeer: eJ }
      : { kcOwn: kcJ, kcPeer: kcO, encOwn: eJ, encPeer: eO };
    const mac = hmac(sha256, this.keys.kcOwn, this.transcript);
    const sent = this.inner
      .sendRaw(JSON.stringify({ t: "kc", v: 1, mac: bytesToBase64Url(mac) }))
      .catch(() => this.fail(new PakeError("Връзката към стаята се прекъсна.", "closed")))
      .finally(() => {
        if (this.pendingKc === sent) this.pendingKc = null;
      });
    this.pendingKc = sent;
  }

  private onKc(frame: { [k: string]: unknown }): void {
    if (this.phase !== "pairing" || !this.keys || !this.transcript || this.peerKcOk) {
      throw new PakeError("Неочаквано потвърждение.", "protocol");
    }
    const mac = b64(frame.mac, 32);
    if (!mac) throw new PakeError("Невалидно потвърждение.", "protocol");
    const expected = hmac(sha256, this.keys.kcPeer, this.transcript);
    if (!ctEqual(mac, expected)) {
      throw new PakeError("Кодът не съвпада. Проверете думите.", "wrong_code");
    }
    this.peerKcOk = true;
    this.phase = "ready";
    this.clearTimer();
    this.resolveReady?.();
    this.rejectReady = this.resolveReady = null;
  }

  private direction(sending: boolean): string {
    const o2j = (this.role === "opener") === sending;
    return o2j ? "o2j" : "j2o";
  }

  private aad(sending: boolean): Uint8Array {
    return utf8(`p2p-pure/pake/box/v1|${(this.code as PairingCode).room}|${this.direction(sending)}`);
  }

  private onBox(frame: { [k: string]: unknown }): void {
    if (this.phase !== "ready" || !this.keys) throw new PakeError("Неочаквано съобщение.", "protocol");
    const n = b64(frame.n, 24);
    const c = b64(frame.c);
    if (!n || !c) throw new PakeError("Невалидно съобщение.", "protocol");
    const counter = counterOf(n);
    if (counter === null || counter <= this.recvCounter) {
      throw new PakeError("Повторено или пренаредено съобщение.", "protocol");
    }
    let plain: Uint8Array;
    try {
      plain = xchacha20poly1305(this.keys.encPeer, n, this.aad(false)).decrypt(c);
    } catch {
      throw new PakeError("Съобщението не може да се разшифрова.", "protocol");
    }
    this.recvCounter = counter;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dec.decode(plain));
    } catch {
      throw new PakeError("Невалидно съдържание.", "protocol");
    }
    if (!isSignalingPayload(parsed)) throw new PakeError("Невалидно съдържание.", "protocol");
    const handlers = parsed.type === "offer" ? this.offerHandlers : this.answerHandlers;
    for (const h of [...handlers]) h(parsed);
  }

  private async sendBox(payload: SignalingPayload): Promise<void> {
    if (this.phase === "failed") throw this.lastError ?? new PakeError("Каналът е затворен.", "closed");
    if (this.phase !== "ready" || !this.keys) {
      throw new PakeError("Каналът още не е потвърден.", "protocol");
    }
    const counter = ++this.sendCounter;
    const nonce = nonceFor(counter);
    const sealed = xchacha20poly1305(this.keys.encOwn, nonce, this.aad(true)).encrypt(utf8(JSON.stringify(payload)));
    try {
      await this.inner.sendRaw(
        JSON.stringify({ t: "box", v: 1, n: bytesToBase64Url(nonce), c: bytesToBase64Url(sealed) }),
      );
    } catch {
      throw new PakeError("Каналът е затворен.", "closed");
    }
  }
}
