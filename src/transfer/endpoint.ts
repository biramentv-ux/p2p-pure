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
 *
 * Terminal-state rules (each one closes a race):
 *   - Once the bundle has left, the sender never sends `abort`: it cannot un-send the seed, and
 *     an abort would only make the new device throw away what it holds. On its deadline it
 *     sends `gone` instead and stops waiting.
 *   - A receiver in `received` keeps the authenticated bundle whatever happens next (abort,
 *     gone, close, a bad frame, its own deadline). It only notes `peerEnded`; reportStored then
 *     throws, so the screen says the old device got no confirmation and will not be wiped.
 *   - Every await is followed by a check that the endpoint is still live, so a deadline or a
 *     close that fires meanwhile cannot be followed by a release or a state change.
 */
import { decodeBundle, encodeBundle, type TransferBundle } from "./bundle";
import { TransferError } from "./packet";
import { openFrame, sealFrame, type FrameMessage, type TransferKeys } from "./session";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";

export interface TransferChannel {
  send(text: string): void;
  onMessage(handler: (text: string) => void): () => void;
  /** Called once when the channel closes or fails, also after it opened. */
  onClose?(handler: (reason: string) => void): () => void;
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
  /** Receiver in `received`: the old device stopped listening, an ack can no longer reach it. */
  peerEnded = false;
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
  private offClose: () => void = () => undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  private readonly opts: EndpointOptions;

  constructor(opts: EndpointOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.off = opts.channel.onMessage((text) => {
      // Frames are handled strictly one after the other, in arrival order.
      this.chain = this.chain.then(() => this.receive(text));
    });
    // A channel that dies after it opened must end the transfer visibly, not leave it waiting.
    if (opts.channel.onClose) {
      this.offClose = opts.channel.onClose(() => {
        // Frames that arrived before the close (e.g. the final `stored`) are handled first.
        this.chain = this.chain.then(() => this.onChannelClosed());
      });
    }
    // Nothing waits past the transfer's expiry.
    const delay = Math.max(0, opts.keys.expiresAt - this.now());
    this.timer = setTimeout(() => this.onDeadline(), delay + 1);
  }

  private onChannelClosed(): void {
    // Our own dispose() closes the channel too: by then the state is final.
    if (this.finished()) return;
    // The new device already holds the bundle: it may still store it (the ack will fail
    // and the screen says so), so the bundle is not thrown away here.
    if (this.state === "received") {
      this.markPeerEnded();
      return;
    }
    this.fail(
      new TransferError(
        this.released
          ? "Връзката прекъсна след изпращането. Провери новото устройство; това устройство не е изтрито."
          : "Връзката с другото устройство прекъсна.",
        "CLOSED",
      ),
      false,
    );
  }

  private finished(): boolean {
    return this.state === "stored" || this.state === "failed" || this.state === "aborted";
  }

  private onDeadline(): void {
    this.timer = undefined;
    if (this.finished() || this.state === "received") return;
    if (this.released) {
      // The seed is out: tell the new device we stop waiting, without voiding its bundle.
      void this.write({ t: "gone" }).catch(() => undefined);
      this.fail(
        new TransferError("Новото устройство не потвърди навреме. Провери го; това устройство не е изтрито.", "EXPIRED"),
        false,
      );
      return;
    }
    this.fail(new TransferError("Времето за прехвърляне изтече.", "EXPIRED"), true);
  }

  /** Receiver keeps its bundle; the old device simply can no longer be told. */
  private markPeerEnded(): void {
    if (this.peerEnded) return;
    this.peerEnded = true;
    // Same state, announced again, so the screen can show that the old device is gone.
    for (const fn of [...this.listeners]) fn(this.state);
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
    if (this.finished()) return;
    this.state = state;
    for (const fn of [...this.listeners]) fn(state);
  }

  private fail(err: TransferError, notifyPeer: boolean): void {
    if (this.finished()) return;
    this.error = err;
    // After release an abort would only make the new device discard the seed it holds.
    if (notifyPeer && !this.released) void this.write({ t: "abort" }).catch(() => undefined);
    this.state = err.code === "ABORTED" || err.code === "SAS_MISMATCH" ? "aborted" : "failed";
    for (const fn of [...this.listeners]) fn(this.state);
    this.dispose();
  }

  private dispose(): void {
    this.off();
    this.offClose();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
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
      this.fail(new TransferError("Каналът е затворен.", "CLOSED"), false);
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
    if (this.finished()) return;
    this.localOk = true;
    this.set(this.role === "sender" ? "waiting-peer" : "waiting-bundle");
    // Called from a button, outside receive()'s error handling: any failure (send, reading the
    // contacts, a bundle too large) ends the transfer through fail() instead of being lost.
    try {
      if (this.role === "receiver") await this.write({ t: "sas-ok" });
      await this.maybeRelease();
    } catch (err) {
      this.fail(this.asTransferError(err), true);
    }
  }

  private asTransferError(err: unknown): TransferError {
    if (err instanceof TransferError) return err;
    return new TransferError("Прехвърлянето не успя. Опитай отново.", "SEND_FAILED");
  }

  /** Receiver: tell the sender the identity is safely stored on this device. */
  async reportStored(did: string): Promise<void> {
    if (this.role !== "receiver" || this.state !== "received") {
      throw new TransferError("Нищо за потвърждаване.", "BAD_STATE");
    }
    if (this.peerEnded) {
      throw new TransferError("Старото устройство вече не чака потвърждение.", "CLOSED");
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

  /** Stop from the UI (cancel button). After `received` this also drops the bundle. */
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
    // Build and check the bundle BEFORE marking it released: a bundle that is too large or a
    // contact book that cannot be read fails here, and nothing has left this device.
    const contents = await this.opts.getBundle();
    // A deadline, close or abort may have ended the transfer while the contacts were read.
    if (this.finished()) {
      contents.seed.fill(0);
      return;
    }
    const bundle = encodeBundle(contents);
    this.released = true;
    this.set("sending");
    try {
      await this.write({ t: "bundle", d: bytesToBase64Url(bundle) });
    } finally {
      bundle.fill(0);
    }
  }

  private async receive(text: string): Promise<void> {
    if (this.finished()) return;
    let msg: FrameMessage;
    try {
      msg = await openFrame(this.opts.keys, this.recvSeq, text);
      this.recvSeq++;
    } catch (err) {
      if (this.state === "received") {
        // Nothing after the bundle can take it back; the channel is just no longer usable.
        this.markPeerEnded();
        return;
      }
      this.fail(err instanceof TransferError ? err : new TransferError("Подправена връзка.", "TAMPERED"), true);
      return;
    }
    if (this.finished()) return;
    if (this.state === "received") {
      // abort, gone or anything else: keep the bundle, note that the old device stopped.
      this.markPeerEnded();
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
    if (msg.t === "abort" || msg.t === "gone") {
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
