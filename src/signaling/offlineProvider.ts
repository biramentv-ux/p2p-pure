/**
 * Local/Offline signaling. No network calls at all.
 *
 * Sending is not transport here: a locally generated payload is handed to the UI through
 * onLocalPayloadGenerated, which shows it as a QR code or text to copy. The other device's
 * payload comes back in through acceptRemotePayload, after a scan or a paste.
 */
import { isSignalingPayload, type ISignalingProvider, type PayloadHandler, type SignalingPayload } from "./types";

export class OfflineSignalingProvider implements ISignalingProvider {
  private offerHandlers: PayloadHandler[] = [];
  private answerHandlers: PayloadHandler[] = [];
  private localHandlers: PayloadHandler[] = [];

  async init(): Promise<void> {
    // Nothing to connect to.
  }

  async sendOffer(payload: SignalingPayload): Promise<void> {
    this.emitLocal(payload);
  }

  async sendAnswer(payload: SignalingPayload): Promise<void> {
    this.emitLocal(payload);
  }

  /** The UI renders this payload as a QR code or as copyable text. */
  onLocalPayloadGenerated(callback: PayloadHandler): void {
    this.localHandlers.push(callback);
  }

  onOfferReceived(callback: PayloadHandler): void {
    this.offerHandlers.push(callback);
  }

  onAnswerReceived(callback: PayloadHandler): void {
    this.answerHandlers.push(callback);
  }

  /**
   * Feeds a scanned or pasted payload into the engine. Anything that does not have the
   * expected shape is rejected before it reaches the handlers.
   */
  acceptRemotePayload(payload: unknown): void {
    if (!isSignalingPayload(payload)) {
      throw new Error("Невалиден сигнален низ.");
    }
    const handlers = payload.type === "offer" ? this.offerHandlers : this.answerHandlers;
    for (const handler of handlers) handler(payload);
  }

  disconnect(): void {
    this.offerHandlers = [];
    this.answerHandlers = [];
    this.localHandlers = [];
  }

  private emitLocal(payload: SignalingPayload): void {
    for (const handler of this.localHandlers) handler(payload);
  }
}
