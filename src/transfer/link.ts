/**
 * Glue between the protocol and WebRTC: the two ways to start a transfer.
 * The old device (sender) calls beginSend, scans the answer, then `connect`.
 * The new device (receiver) calls answerOffer, shows the answer, then `connect`.
 * Signalling is the same manual one as for contacts: QR codes or pasted text, no server.
 */
import { PeerLink } from "../p2p/peer";
import { TransferEndpoint, type EndpointOptions, type TransferChannel } from "./endpoint";
import {
  TransferError,
  decodeTransferPacket,
  encodeTransferPacket,
  encodeTransferPacketHex,
  newAnswer,
  newEphemeral,
  newOffer,
  type TransferPacket,
} from "./packet";
import { deriveTransferKeys } from "./session";

export function peerChannel(link: PeerLink): TransferChannel {
  return {
    send: (text) => link.send(text),
    onMessage: (h) => link.onMessage(h),
    onClose: (h) => link.onClose(h),
    close: () => link.close(),
  };
}

export interface SenderOffer {
  link: PeerLink;
  offer: TransferPacket;
  secretKey: Uint8Array;
  text: string;
  hex: string;
  /** An offer takes exactly one answer; a second one is refused. */
  consumed: boolean;
}

export async function beginSend(now = Date.now()): Promise<SenderOffer> {
  const { link, sdp } = await PeerLink.createOffer();
  const eph = newEphemeral();
  const offer = newOffer(sdp, eph.publicKey, now);
  return {
    link,
    offer,
    secretKey: eph.secretKey,
    text: await encodeTransferPacket(offer),
    hex: await encodeTransferPacketHex(offer),
    consumed: false,
  };
}

/** Sender: validates the scanned answer, applies it, and returns the keys for the endpoint. */
export async function acceptAnswerText(state: SenderOffer, text: string, now = Date.now()) {
  if (state.consumed) throw new TransferError("Тази покана вече е използвана.", "REPLAYED");
  const answer = await decodeTransferPacket(text, now);
  if (answer.kind !== "answer") throw new TransferError("Това не е отговор.", "WRONG_KIND");
  const keys = deriveTransferKeys("sender", state.secretKey, state.offer, answer);
  state.consumed = true;
  state.secretKey.fill(0);
  await state.link.acceptAnswer(answer.sdp);
  return keys;
}

export interface ReceiverAnswer {
  link: PeerLink;
  text: string;
  hex: string;
  keys: ReturnType<typeof deriveTransferKeys>;
}

/** Receiver: validates the scanned offer and produces the answer to show. */
export async function answerOffer(offerText: string, now = Date.now()): Promise<ReceiverAnswer> {
  const offer = await decodeTransferPacket(offerText, now);
  if (offer.kind !== "offer") throw new TransferError("Това не е покана.", "WRONG_KIND");
  const { link, sdp } = await PeerLink.createAnswer(offer.sdp);
  const eph = newEphemeral();
  const answer = newAnswer(offer, sdp, eph.publicKey);
  const keys = deriveTransferKeys("receiver", eph.secretKey, offer, answer);
  eph.secretKey.fill(0);
  return {
    link,
    keys,
    text: await encodeTransferPacket(answer),
    hex: await encodeTransferPacketHex(answer),
  };
}

/** Opens the channel, starts the protocol. Resolves with the endpoint once the link is open. */
export async function runEndpoint(
  link: PeerLink,
  opts: Omit<EndpointOptions, "channel">,
  waitMs?: number,
): Promise<TransferEndpoint> {
  const endpoint = new TransferEndpoint({ ...opts, channel: peerChannel(link) });
  await link.waitForOpen(waitMs);
  await endpoint.start();
  return endpoint;
}
