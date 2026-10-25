/**
 * Test harness page: exposes the real P2P modules to an external driver
 * (tests/e2e/run.mjs). Two independent browser pages run the app's own
 * invitation, WebRTC, handshake, session and safety-code code.
 */
import { generateMnemonic12, mnemonicToSeed } from "../../../src/identity/mnemonic";
import { deriveIdentityKeyPair } from "../../../src/identity/keypair";
import { publicKeyToDidKey } from "../../../src/identity/didKey";
import type { Ed25519KeyPair } from "../../../src/identity/types";
import {
  assertKind,
  bytesEqual,
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  type Invitation,
} from "../../../src/p2p/invitation";
import { PeerLink } from "../../../src/p2p/peer";
import { completeHandshake } from "../../../src/p2p/session";
import { decodeQrFromPixels } from "../../../src/p2p/qrDecode";
import {
  createEphemeralKeyPair,
  isEncryptedMessage,
  SecureSession,
  type EphemeralKeyPair,
} from "../../../src/p2p/secureSession";
import { safetyWords, formatSafetyCode } from "../../../src/p2p/safety";
import { identityX25519Public } from "../../../src/identity/x25519";
import QRCode from "qrcode";

const identity: Ed25519KeyPair = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const did = publicKeyToDidKey(identity.publicKey);

let link: PeerLink | null = null;
let offerInv: Invitation | null = null;
let eph: EphemeralKeyPair | null = null;
let session: SecureSession | null = null;
let peerPublicKey: Uint8Array | null = null;
let lastWire: string | null = null;
const received: string[] = [];
const securityErrors: string[] = [];

function attachSecureReceiver(l: PeerLink) {
  l.onMessage((text) => {
    if (!isEncryptedMessage(text) || !session) return;
    session
      .open(text)
      .then((pt) => received.push(pt))
      .catch((e: Error) => securityErrors.push(e.message));
  });
}

const api = {
  did,

  /** Initiator: build the signed offer (with ephemeral key). */
  async makeOffer(): Promise<string> {
    const created = await PeerLink.createOffer();
    link = created.link;
    eph = createEphemeralKeyPair();
    offerInv = createInvitation("offer", created.sdp, identity, eph.publicKey);
    return encodeInvitation(offerInv);
  },

  /** Responder: consume the offer, produce the answer, derive the session. */
  async makeAnswer(offerPayload: string): Promise<{ payload: string; peerDid: string }> {
    const offer = await decodeInvitation(offerPayload);
    assertKind(offer, "offer");
    const created = await PeerLink.createAnswer(offer.sdp);
    link = created.link;
    const myEph = createEphemeralKeyPair();
    const inv = createInvitation("answer", created.sdp, identity, myEph.publicKey, {
      answersNonce: offer.nonce,
    });
    peerPublicKey = offer.publicKey;
    session = SecureSession.derive({
      role: "responder",
      myIdentity: identity,
      myEphemeral: myEph,
      peerIdentityPublicKey: offer.publicKey,
      peerEphemeralPublicKey: offer.ephemeralPublicKey,
    });
    // Handshake first, then the encrypted receiver: anything earlier is buffered by PeerLink.
    api._pending = completeHandshake(link, did, offer.publicKey, 60_000);
    const payload = await encodeInvitation(inv);
    attachSecureReceiver(link);
    return { payload, peerDid: publicKeyToDidKey(offer.publicKey) };
  },

  /** Initiator: accept the answer, complete the handshake, derive the session. */
  async acceptAnswer(answerPayload: string): Promise<string> {
    const answer = await decodeInvitation(answerPayload);
    assertKind(answer, "answer");
    if (!answer.answersNonce || !offerInv || !bytesEqual(answer.answersNonce, offerInv.nonce)) {
      throw new Error("answer does not reference our offer");
    }
    await link!.acceptAnswer(answer.sdp);
    const peerDid = await completeHandshake(link!, did, answer.publicKey, 60_000);
    peerPublicKey = answer.publicKey;
    session = SecureSession.derive({
      role: "initiator",
      myIdentity: identity,
      myEphemeral: eph!,
      peerIdentityPublicKey: answer.publicKey,
      peerEphemeralPublicKey: answer.ephemeralPublicKey,
    });
    attachSecureReceiver(link!);
    return peerDid;
  },

  /** Responder: wait for the handshake that was started in makeAnswer. */
  async awaitResponderHandshake(): Promise<string> {
    return (api as any)._pending;
  },

  /** Encrypt and send. Returns the exact wire string so the driver can inspect it. */
  async sendSecure(text: string): Promise<string> {
    const wire = await session!.seal(text);
    lastWire = wire;
    link!.send(wire);
    return wire;
  },

  /** Re-send the last wire message unchanged (replay attempt). */
  replayLast(): void {
    link!.send(lastWire!);
  },

  /** Plaintexts this side has successfully decrypted, in order. */
  receivedTexts(): string[] {
    return [...received];
  },

  /** Decryption/replay errors seen by this side. */
  securityErrors(): string[] {
    return [...securityErrors];
  },

  /** Safety code words from both public keys, as the UI would show them. */
  safetyCode(): string {
    return formatSafetyCode(
      safetyWords(identityX25519Public(identity.publicKey), identityX25519Public(peerPublicKey!)),
    );
  },

  /** Render a payload to a QR canvas and decode it back with jsQR. */
  async qrRoundTrip(payload: string): Promise<boolean> {
    const canvas = document.createElement("canvas");
    await QRCode.toCanvas(canvas, payload, { errorCorrectionLevel: "M", margin: 2, width: 600 });
    const ctx = canvas.getContext("2d")!;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeQrFromPixels(img.data, img.width, img.height) === payload;
  },

  close(): void {
    link?.close();
  },
} as Record<string, any>;

(window as unknown as { harness: typeof api }).harness = api as any;
document.title = "harness-ready";
