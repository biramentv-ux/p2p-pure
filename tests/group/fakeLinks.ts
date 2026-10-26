/**
 * In-memory stand-ins for PeerLink that deliver by themselves (on a later tick), and a
 * LinkFactory that pairs an offer with its answer through the SDP text, like WebRTC would.
 * Not a test file: shared by the group tests.
 */
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import type { Ed25519KeyPair } from "../../src/identity/types";
import type { Contact } from "../../src/contacts/contacts";
import { createEphemeralKeyPair, SecureSession } from "../../src/p2p/secureSession";
import type { AutoLink, LinkFactory } from "../../src/group/groupLinker";

export interface Person {
  keys: Ed25519KeyPair;
  did: string;
  contact: Contact;
}

export function person(name: string): Person {
  const keys = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  const did = publicKeyToDidKey(keys.publicKey);
  return { keys, did, contact: { did, publicKey: keys.publicKey, name, verified: true, addedAt: 0 } };
}

export class AutoFakeLink implements AutoLink {
  peer: AutoFakeLink | null = null;
  private opened = false;
  private closed = false;
  private handlers = new Set<(text: string) => void>();
  private binaryHandlers = new Set<(bytes: Uint8Array) => void>();
  /** How many binary messages this side sent (file chunks). */
  binarySent = 0;
  private pending: string[] = [];
  private openWaiters: Array<() => void> = [];
  /** Every text this side sent, for checks that nothing leaks in plaintext. */
  readonly sent: string[] = [];

  markOpen(): void {
    this.opened = true;
    for (const w of this.openWaiters.splice(0)) w();
  }

  isOpen(): boolean {
    return this.opened && !this.closed;
  }

  waitForOpen(timeoutMs = 5_000): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the data channel to open.")), timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  send(text: string): void {
    if (!this.isOpen() || !this.peer) throw new Error("Data channel is not open.");
    this.sent.push(text);
    const peer = this.peer;
    setTimeout(() => peer.deliver(text), 0);
  }

  private deliver(text: string): void {
    if (this.closed) return;
    if (this.handlers.size === 0) {
      this.pending.push(text);
      return;
    }
    for (const h of [...this.handlers]) h(text);
  }

  async sendBinary(bytes: Uint8Array): Promise<void> {
    if (!this.isOpen() || !this.peer) throw new Error("Data channel is not open.");
    this.binarySent++;
    const peer = this.peer;
    const copy = bytes.slice();
    setTimeout(() => peer.deliverBinary(copy), 0);
  }

  private deliverBinary(bytes: Uint8Array): void {
    if (this.closed) return;
    for (const h of [...this.binaryHandlers]) h(bytes);
  }

  onBinary(handler: (bytes: Uint8Array) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onMessage(handler: (text: string) => void): () => void {
    this.handlers.add(handler);
    if (this.pending.length > 0) {
      const queued = this.pending;
      this.pending = [];
      for (const text of queued) handler(text);
    }
    return () => this.handlers.delete(handler);
  }

  async acceptAnswer(sdp: string): Promise<void> {
    const answer = factoryAnswers.get(sdp);
    if (!answer) throw new Error("unknown answer");
    this.peer = answer;
    answer.peer = this;
    this.markOpen();
    answer.markOpen();
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

const factoryOffers = new Map<string, AutoFakeLink>();
const factoryAnswers = new Map<string, AutoFakeLink>();
let counter = 0;

/** Links made by the factory, so a test can look at their traffic. */
export const madeLinks: AutoFakeLink[] = [];

export const fakeFactory: LinkFactory = {
  async createOffer() {
    const link = new AutoFakeLink();
    const sdp = `v=0 fake-offer ${++counter}`;
    factoryOffers.set(sdp, link);
    madeLinks.push(link);
    return { link, sdp };
  },
  async createAnswer(offerSdp: string) {
    if (!factoryOffers.has(offerSdp)) throw new Error("unknown offer");
    const link = new AutoFakeLink();
    const sdp = offerSdp.replace("fake-offer", "fake-answer");
    factoryAnswers.set(sdp, link);
    madeLinks.push(link);
    return { link, sdp };
  },
};

/** An open link pair with a real encrypted session on each end, as after a QR connect. */
export function connectedPair(a: Person, b: Person) {
  const ephA = createEphemeralKeyPair();
  const ephB = createEphemeralKeyPair();
  const sa = SecureSession.derive({
    role: "initiator", myIdentity: a.keys, myEphemeral: ephA,
    peerIdentityPublicKey: b.keys.publicKey, peerEphemeralPublicKey: ephB.publicKey,
  });
  const sb = SecureSession.derive({
    role: "responder", myIdentity: b.keys, myEphemeral: ephB,
    peerIdentityPublicKey: a.keys.publicKey, peerEphemeralPublicKey: ephA.publicKey,
  });
  const la = new AutoFakeLink();
  const lb = new AutoFakeLink();
  la.peer = lb;
  lb.peer = la;
  la.markOpen();
  lb.markOpen();
  return { la, lb, sa, sb };
}

/** Polls until the condition holds (async crypto and timers settle on their own schedule). */
export async function until(cond: () => boolean, label = "condition", timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Waits a little for things that should NOT happen. */
export function quiet(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A tiny valid PNG-signed byte string of the given size (enough for sniffMime). */
export function pngBytes(size: number, fill = 7): Uint8Array {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}
