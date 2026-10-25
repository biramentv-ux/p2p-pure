/**
 * Signaling is how two peers exchange the SDP and identity they need before WebRTC can
 * connect. The WebRTC engine (src/p2p/) only sees this interface, never the transport.
 */
export interface SignalingPayload {
  type: "offer" | "answer";
  sdp: string;
  /** Sender's did:key. */
  did: string;
  nonce: string;
  displayName?: string;
}

export type PayloadHandler = (payload: SignalingPayload) => void;

export interface ISignalingProvider {
  init(): Promise<void>;
  sendOffer(payload: SignalingPayload): Promise<void>;
  sendAnswer(payload: SignalingPayload): Promise<void>;
  onOfferReceived(callback: PayloadHandler): void;
  onAnswerReceived(callback: PayloadHandler): void;
  disconnect(): void;
}

/** Shape check for any payload that arrives from outside (a scanned QR, a pasted text, a socket). */
export function isSignalingPayload(value: unknown): value is SignalingPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "offer" || v.type === "answer") &&
    typeof v.sdp === "string" &&
    typeof v.did === "string" &&
    typeof v.nonce === "string" &&
    (v.displayName === undefined || typeof v.displayName === "string")
  );
}
