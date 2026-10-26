/**
 * The transfer protocol as a state machine over an abstract channel (a PeerLink in the app, an
 * in-memory pair in tests).
 *
 *   both:      hello (proves both derived the same keys)
 *   both:      show the 6 SAS words; each user compares them and answers
 *   receiver:  sas-ok  -> sender
 *   sender:    sends the bundle ONLY when its own user said "match" AND sas-ok arrived
 *   receiver:  stores the identity, then sends stored(did) (or failed)
 *   sender:    checks did == own did -> "stored"; the UI then offers to wipe this device
 *
 * Any frame that does not open, is out of order, or has a type that is wrong for the state
 * aborts the transfer. The sender never releases the seed before both SAS confirmations.
 */
import { decodeBundle, encodeBundle, type TransferBundle } from "./bundle";
import { TransferError } from "./packet";
import { openFrame, sealFrame, type FrameMessage, type TransferKeys } from "./session";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";

export interface TransferChannel {
  send(text: string): void;
  onMessage(handler: (text: string) => void): () => void;
  close(): void;
}

export type TransferState =
  | "connecting" // waiting for the peer's hello
  | "compare" // SAS words shown, waiting for both confirmations
  | "waiting-peer" // this user confirmed, the other side has not yet
  | "sending" // sender: bundle released
  | "waiting-bundle" // receiver: confirmed, bundle not yet here
  | "received" // receiver: bundle in `bundle`, to be stored
  | "stored" // done on the receiving side (sender: ack arrived)
  | "failed"
  | "aborted";

export interface EndpointOptions {
  keys: TransferKeys;
  channel: TransferChannel;
  now?: () => number;
  /** Sender only: builds the bundle at the moment of release (after both SAS confirmations). */
  getBundle?: () => Promise<TransferBundle>;
  /** Sender only: this device's DID; the receiver's `stored` must report the same one. */
  ownDid?: string;
}

export class TransferEndpoint {
  state: TransferState = "connecting";
  error: TransferError | null = null;
  bundle: TransferBundle | null = null;
  private listeners = new Set<(s: TransferState) => void>();
  private sendSeq = 0;
  private recvSeq = 0;
  private helloSent = false;
  private helloSeen = false;
  private localOk = false;
  private remoteOk = false;
  private released = false;
  private chain: Promise<void> = Promise.resolve();
  private off: () => void;
  private readonly now: () => number;

  private readonly opts: EndpointOptions;

  constructor(opts: EndpointOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.off = opts.channel.onMessage((text) => {
      // Frames are handled strictly one after the other, in arrival order.
      this.chain = this.chain.then(() => this.receive(text));
    });
  }

  get words(): string[] {
    return this.opts.keys.sasWords;
  }

  get role() {
    return this.opts.keys.role;
  }

  onState(fn: (s: TransferState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: TransferState): void {
    if (this.state === "aborted" || this.state === "failed") return;
    this.state = state;
    for (const fn of [...this.listeners]) fn(state);
  }

  private fail(err: TransferError, notifyPeer: boolean): void {
    if (this.state === "aborted" || this.state === "failed") return;
    this.error = err;
    if (notifyPeer) void this.write({ t: "abort" }).catch(() => undefined);
    this.state = err.code === "ABORTED" || err.code === "SAS_MISMATCH" ? "aborted" : "failed";
    for (const fn of [...this.listeners]) fn(this.state);
    this.dispose();
  }

  private dispose(): void {
    this.off();
    // Give the abort frame a moment to leave before the channel goes away.
    setTimeout(() => this.opts.channel.close(), 50);
  }

  private async write(msg: FrameMessage): Promise<void> {
    const text = await sealFrame(this.opts.keys, this.sendSeq++, msg);
    this.opts.channel.send(text);
  }

  private expired(): boolean {
    return this.now() > this.opts.keys.expiresAt;
  }

  /** Call once the channel is open. */
  async start(): Promise<void> {
    if (this.helloSent) return;
    this.helloSent = true;
    try {
      await this.write({ t: "hello" });
    } catch {
      this.fail(new TransferError("Каналът е затворен.", "TIMEOUT"), false);
    }
  }

  /** The user's answer to "do the words match?". `false` ends the transfer for both. */
  async confirmSas(match: boolean): Promise<void> {
    if (this.state !== "compare") throw new TransferError("Сега не е време за сравнение.", "BAD_STATE");
    if (!match) {
      this.fail(new TransferError("Думите не съвпаднаха. Прехвърлянето е прекратено.", "SAS_MISMATCH"), true);
      return;
    }
    if (this.expired()) {
      this.fail(new TransferError("Времето за прехвърляне изтече.", "EXPIRED"), true);
      return;
    }
    this.localOk = true;
    this.set(this.role === "sender" ? "waiting-peer" : "waiting-bundle");
    if (this.role === "receiver") await this.write({ t: "sas-ok" });
    await this.maybeRelease();
  }

  /** Receiver: tell the sender the identity is safely stored on this device. */
  async reportStored(did: string): Promise<void> {
    if (this.role !== "receiver" || this.state !== "received") {
      throw new TransferError("Нищо за потвърждаване.", "BAD_STATE");
    }
    await this.write({ t: "stored", did });
    this.set("stored");
    this.dispose();
  }

  /** Receiver: storing failed, tell the sender so it keeps its identity. */
  async reportFailed(): Promise<void> {
    await this.write({ t: "failed" }).catch(() => undefined);
    this.fail(new TransferError("Запазването на това устройство не успя.", "BAD_BUNDLE"), false);
  }

  /** Stop from the UI (cancel button). */
  abort(): void {
    this.fail(new TransferError("Прекратено.", "ABORTED"), true);
  }

  private async maybeRelease(): Promise<void> {
    if (this.role !== "sender" || this.released || !this.localOk || !this.remoteOk) return;
    if (this.expired()) {
      this.fail(new TransferError("Времето за прехвърляне изтече.", "EXPIRED"), true);
      return;
    }
    if (!this.opts.getBundle) throw new TransferError("Няма данни за изпращане.", "BAD_STATE");
    this.released = true;
    this.set("sending");
    const bundle = encodeBundle(await this.opts.getBundle());
    await this.write({ t: "bundle", d: bytesToBase64Url(bundle) });
    bundle.fill(0);
  }

  private async receive(text: string): Promise<void> {
    if (this.state === "aborted" || this.state === "failed") return;
    let msg: FrameMessage;
    try {
      msg = await openFrame(this.opts.keys, this.recvSeq, text);
      this.recvSeq++;
    } catch (err) {
      this.fail(err instanceof TransferError ? err : new TransferError("Подправена връзка.", "TAMPERED"), true);
      return;
    }
    try {
      await this.handle(msg);
    } catch (err) {
      this.fail(err instanceof TransferError ? err : new TransferError("Неочаквана грешка.", "TAMPERED"), true);
    }
  }

  private async handle(msg: FrameMessage): Promise<void> {
    const wrong = () => new TransferError("Неочакван ред на съобщенията.", "BAD_STATE");
    if (msg.t === "abort") {
      this.fail(new TransferError("Другото устройство прекрати прехвърлянето.", "ABORTED"), false);
      return;
    }
    if (msg.t === "failed") {
      if (this.role !== "sender" || this.state !== "sending") throw wrong();
      this.fail(new TransferError("Новото устройство не успя да запази идентичността.", "BAD_BUNDLE"), false);
      return;
    }
    switch (this.state) {
      case "connecting":
        if (msg.t !== "hello" || this.helloSeen) throw wrong();
        this.helloSeen = true;
        this.set("compare");
        return;
      case "compare":
      case "waiting-peer":
      case "waiting-bundle":
        if (msg.t === "sas-ok" && this.role === "sender" && !this.remoteOk) {
          this.remoteOk = true;
          await this.maybeRelease();
          return;
        }
        if (msg.t === "bundle" && this.role === "receiver" && this.state === "waiting-bundle") {
          if (this.expired()) throw new TransferError("Времето за прехвърляне изтече.", "EXPIRED");
          this.bundle = decodeBundle(base64UrlToBytes(msg.d));
          this.set("received");
          return;
        }
        throw wrong();
      case "sending":
        if (msg.t === "stored" && this.role === "sender") {
          if (!this.opts.ownDid || msg.did !== this.opts.ownDid) {
            throw new TransferError("Новото устройство съобщи различна идентичност.", "IDENTITY_MISMATCH");
          }
          this.set("stored");
          this.dispose();
          return;
        }
        throw wrong();
      default:
        throw wrong();
    }
  }
}
