/**
 * Auto-linking between group members, without QR codes.
 *
 * The admin is linked to everyone. When two members (or a member and a candidate) need a
 * link of their own, they exchange the normal signed WebRTC invitations (p2p/invitation.ts)
 * through the admin, inside the encrypted pairwise links:
 *
 *   A: createOffer, sign it         -> admin -> B
 *   B: check, createAnswer, sign it -> admin -> A
 *   A and B: direct WebRTC link, hello handshake, SecureSession (Double Ratchet)
 *
 * What the admin can and cannot do:
 *  - It sees the invitations (SDP: IP candidates, DTLS fingerprint), as a QR code would show them.
 *  - It cannot forge one: every invitation is signed by its sender's identity key, the
 *    signature covers the SDP (DTLS fingerprint) and the ephemeral key, and the receiver
 *    checks that the signing key is exactly the member the relay says it is from.
 *  - It can refuse to forward. Then the link is simply not made.
 *
 * Which peers are accepted is decided by GroupMesh (members of the signed state, or
 * candidates introduced by the admin). This module checks the invitation itself.
 *
 * Verification: a link made this way is bound to the peer's identity key, but nobody has
 * compared the safety code yet. GroupSession marks such a peer "not verified" unless it is
 * already a verified contact; the user can compare the code later on the group screen.
 */
import { publicKeyToDidKey } from "../identity/didKey";
import type { DidKey, Ed25519KeyPair } from "../identity/types";
import {
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  type Invitation,
} from "../p2p/invitation";
import { CONNECT_TIMEOUT_MS, PeerLink } from "../p2p/peer";
import { createEphemeralKeyPair, SecureSession, type EphemeralKeyPair } from "../p2p/secureSession";
import { completeHandshake } from "../p2p/session";
import { bytesToBase64Url } from "../p2p/encoding";
import { MAX_RELAY_INVITATION_CHARS } from "./groupChat";

/** What auto-linking needs from a link. PeerLink has all of it. */
export type AutoLink = Pick<PeerLink, "send" | "onMessage" | "waitForOpen" | "close" | "isOpen" | "acceptAnswer"> &
  Partial<Pick<PeerLink, "waitForDrain">>;

/** Makes WebRTC links. In the app this is PeerLink; tests pass an in-memory pair. */
export interface LinkFactory {
  createOffer(): Promise<{ link: AutoLink; sdp: string }>;
  createAnswer(offerSdp: string): Promise<{ link: AutoLink; sdp: string }>;
}

/** Real WebRTC links (public STUN only, as everywhere in the app). */
export const webrtcLinks: LinkFactory = {
  createOffer: () => PeerLink.createOffer(),
  createAnswer: (offerSdp) => PeerLink.createAnswer(offerSdp),
};

export interface LinkerOptions {
  identity: Ed25519KeyPair;
  factory: LinkFactory;
  /** Sends a signed invitation to `to` through the admin (GroupMesh.relay). */
  relay(to: DidKey, invitation: string): Promise<void>;
  /** A finished link: verified handshake and a fresh encrypted session. */
  linked(peer: DidKey, peerPublicKey: Uint8Array, link: AutoLink, session: SecureSession): void;
  /** How long the answering side waits for the link to open. */
  timeoutMs?: number;
}

export class LinkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkerError";
  }
}

interface PendingOffer {
  peer: DidKey;
  link: AutoLink;
  eph: EphemeralKeyPair;
  timer: ReturnType<typeof setTimeout>;
}

/** Answered offers are remembered for this long, so a replayed offer is refused. */
const SEEN_TTL_MS = 15 * 60 * 1000;

export class GroupLinker {
  private readonly opts: LinkerOptions;
  private readonly myDid: DidKey;
  /** Our own open offers, by nonce. */
  private readonly offers = new Map<string, PendingOffer>();
  /** Peers with an attempt in flight (either direction). */
  private readonly busy = new Set<DidKey>();
  /** Nonces of offers already answered, with the time they were seen. */
  private readonly seen = new Map<string, number>();
  private closed = false;

  constructor(opts: LinkerOptions) {
    this.opts = opts;
    this.myDid = publicKeyToDidKey(opts.identity.publicKey);
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /** True while a link to this peer is being made. */
  isBusy(peer: DidKey): boolean {
    return this.busy.has(peer);
  }

  /** Starts a link to `peer`: a signed offer through the admin. */
  async offerTo(peer: DidKey): Promise<void> {
    if (this.closed || peer === this.myDid || this.busy.has(peer)) return;
    this.busy.add(peer);
    let link: AutoLink | null = null;
    try {
      const made = await this.opts.factory.createOffer();
      link = made.link;
      const eph = createEphemeralKeyPair();
      const offer = createInvitation("offer", made.sdp, this.opts.identity, eph.publicKey);
      const text = await encodeInvitation(offer);
      if (text.length > MAX_RELAY_INVITATION_CHARS) throw new LinkerError("Поканата е твърде голяма за препращане.");
      const nonce = bytesToBase64Url(offer.nonce);
      const timer = setTimeout(() => this.dropOffer(nonce), this.timeoutMs * 2);
      this.offers.set(nonce, { peer, link, eph, timer });
      await this.opts.relay(peer, text);
    } catch (err) {
      link?.close();
      this.busy.delete(peer);
      throw err;
    }
  }

  /**
   * A relayed invitation from `from`. GroupMesh already checked that `from` is a member (or
   * an introduced candidate). Here: the signature, the expiry, and that the key is `from`'s.
   */
  async receive(from: DidKey, text: string): Promise<void> {
    if (this.closed) return;
    const inv = await decodeInvitation(text);
    if (publicKeyToDidKey(inv.publicKey) !== from) {
      throw new LinkerError("Поканата не е подписана от участника, от когото идва.");
    }
    if (inv.kind === "offer") await this.answer(from, inv);
    else await this.complete(from, inv);
  }

  private async answer(from: DidKey, offer: Invitation): Promise<void> {
    const nonce = bytesToBase64Url(offer.nonce);
    this.pruneSeen();
    if (this.seen.has(nonce)) throw new LinkerError("Тази покана вече беше използвана.");
    this.seen.set(nonce, Date.now());
    // Both sides offered at once: the side with the smaller DID keeps its own offer.
    const mine = [...this.offers.entries()].find(([, o]) => o.peer === from);
    if (mine) {
      if (this.myDid < from) return;
      this.dropOffer(mine[0]);
    } else if (this.busy.has(from)) {
      return;
    }
    this.busy.add(from);
    let link: AutoLink | null = null;
    try {
      const made = await this.opts.factory.createAnswer(offer.sdp);
      link = made.link;
      const eph = createEphemeralKeyPair();
      const answer = createInvitation("answer", made.sdp, this.opts.identity, eph.publicKey, { answersNonce: offer.nonce });
      const text = await encodeInvitation(answer);
      if (text.length > MAX_RELAY_INVITATION_CHARS) throw new LinkerError("Поканата е твърде голяма за препращане.");
      // Start waiting before the answer leaves, so the hello cannot be missed.
      const handshake = completeHandshake(link, this.myDid, offer.publicKey, this.timeoutMs * 2);
      await this.opts.relay(from, text);
      await handshake;
      if (this.closed) throw new LinkerError("Групата е затворена.");
      const session = SecureSession.derive({
        role: "responder",
        myIdentity: this.opts.identity,
        myEphemeral: eph,
        peerIdentityPublicKey: offer.publicKey,
        peerEphemeralPublicKey: offer.ephemeralPublicKey,
      });
      this.opts.linked(from, offer.publicKey, link, session);
      link = null;
    } finally {
      link?.close();
      this.busy.delete(from);
    }
  }

  private async complete(from: DidKey, answer: Invitation): Promise<void> {
    if (!answer.answersNonce) throw new LinkerError("Този отговор не е за тази покана.");
    const nonce = bytesToBase64Url(answer.answersNonce);
    const pending = this.offers.get(nonce);
    if (!pending || pending.peer !== from) throw new LinkerError("Този отговор не е за тази покана.");
    this.offers.delete(nonce);
    clearTimeout(pending.timer);
    let link: AutoLink | null = pending.link;
    try {
      await link.acceptAnswer(answer.sdp);
      await completeHandshake(link, this.myDid, answer.publicKey, this.timeoutMs);
      if (this.closed) throw new LinkerError("Групата е затворена.");
      const session = SecureSession.derive({
        role: "initiator",
        myIdentity: this.opts.identity,
        myEphemeral: pending.eph,
        peerIdentityPublicKey: answer.publicKey,
        peerEphemeralPublicKey: answer.ephemeralPublicKey,
      });
      this.opts.linked(from, answer.publicKey, link, session);
      link = null;
    } finally {
      link?.close();
      this.busy.delete(from);
    }
  }

  private dropOffer(nonce: string): void {
    const o = this.offers.get(nonce);
    if (!o) return;
    this.offers.delete(nonce);
    clearTimeout(o.timer);
    o.link.close();
    this.busy.delete(o.peer);
  }

  private pruneSeen(): void {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [nonce, at] of this.seen) if (at < cutoff) this.seen.delete(nonce);
  }

  /** Closes every link still being made. */
  close(): void {
    this.closed = true;
    for (const nonce of [...this.offers.keys()]) this.dropOffer(nonce);
    this.busy.clear();
  }
}
