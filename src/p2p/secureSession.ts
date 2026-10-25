/**
 * End-to-end encrypted session between two verified identities.
 *
 * Key agreement (X3DH-style, both sides compute the same secret):
 *   DH1 = X25519(identity of initiator, ephemeral of responder)
 *   DH2 = X25519(ephemeral of initiator, identity of responder)
 *   DH3 = X25519(ephemeral of initiator, ephemeral of responder)
 *   ikm  = DH1 || DH2 || DH3
 *   root = HKDF(ikm, salt = SHA-256(transcript), info = "root")
 *   transcript = identityI || identityR || ephemeralI || ephemeralR
 *
 * Double Ratchet (after https://signal.org/docs/specifications/doubleratchet/):
 *   - The responder's initial ratchet key is its invitation ephemeral.
 *   - The initiator generates its first ratchet key at derive time and performs
 *     the first DH ratchet step immediately, so it can send first.
 *   - A DH ratchet step runs when a message arrives with a new `dh` key. It
 *     derives a new receiving chain. The new sending key and chain are derived
 *     lazily, on the next seal, so every direction switch uses a fresh key.
 *   - Each chain step is HMAC based (0x01 = message key, 0x02 = next chain key).
 *     Message keys are AES-256-GCM keys, used once.
 *   - Skipped message keys are cached (bounded by MAX_SKIP per chain) so that
 *     late, out-of-order messages still decrypt. Each cached key is deleted
 *     after use.
 *   - All receive state changes are computed on copies and committed only
 *     after the message authenticates.
 *
 * Wire format: {"t":"msg","n","pn","dh","iv","ct"} with the header fields
 * (n, pn, dh) bound as associated data together with the direction.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  aeadOpen,
  aeadSeal,
  DEFAULT_CIPHER_SUITE,
  suiteAadByte,
  suiteFromWireTag,
  suiteWireTag,
  type CipherSuite,
} from "./cipherSuite";
import type { Ed25519KeyPair } from "../identity/types";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding";

export type Role = "initiator" | "responder";

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface EphemeralKeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function createEphemeralKeyPair(): EphemeralKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Maximum number of message keys skipped (cached) per chain. */
export const MAX_SKIP = 100;

const enc = new TextEncoder();
const LABEL_ROOT = enc.encode("p2p-messenger/session/root/v1");
const LABEL_RATCHET = enc.encode("p2p-messenger/session/ratchet/v2");
const MSG_TYPE = "msg";
const MAX_PLAINTEXT_CHARS = 4_000;
const DH_LEN = 32;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Ed25519 identity seed -> X25519 scalar and public key (birational map). */
function identityToX25519(kp: Ed25519KeyPair): { secretKey: Uint8Array; publicKey: Uint8Array } {
  return {
    secretKey: ed25519.utils.toMontgomerySecret(kp.secretKey),
    publicKey: ed25519.utils.toMontgomery(kp.publicKey),
  };
}

function chainStep(chainKey: Uint8Array, byte: number): Uint8Array {
  return hmac(sha256, chainKey, Uint8Array.of(byte));
}

/** KDF_RK: root key as HKDF salt, DH output as input key material. */
function kdfRootKey(rootKey: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dhOut, rootKey, LABEL_RATCHET, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new SessionError("Malformed message.");
  }
}

/** AAD = suite byte || direction || n || pn || dh. The suite byte is 'm' for AES-GCM. */
function headerAad(suite: CipherSuite, direction: number, n: number, pn: number, dhPub: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + 4 + 4 + DH_LEN);
  out[0] = suiteAadByte(suite);
  out[1] = direction;
  const view = new DataView(out.buffer);
  view.setUint32(2, n >>> 0);
  view.setUint32(6, pn >>> 0);
  out.set(dhPub, 10);
  return out;
}

interface ParsedMessage {
  suite: CipherSuite;
  n: number;
  pn: number;
  dh: Uint8Array;
  iv: string;
  ct: string;
}

function isCounter(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

function parseWire(wire: string): ParsedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch {
    throw new SessionError("Malformed message.");
  }
  if (typeof parsed !== "object" || parsed === null) throw new SessionError("Malformed message.");
  const msg = parsed as Record<string, unknown>;
  if (
    msg.t !== MSG_TYPE ||
    !isCounter(msg.n) ||
    !isCounter(msg.pn) ||
    typeof msg.dh !== "string" ||
    typeof msg.iv !== "string" ||
    typeof msg.ct !== "string"
  ) {
    throw new SessionError("Malformed message.");
  }
  // Messages from before suites existed have no "s" field: they are AES-GCM.
  const suite = msg.s === undefined ? DEFAULT_CIPHER_SUITE : suiteFromWireTag(msg.s);
  if (suite === null) throw new SessionError("Malformed message.");
  let dhPub: Uint8Array;
  try {
    dhPub = base64UrlToBytes(msg.dh);
  } catch {
    throw new SessionError("Malformed message.");
  }
  if (dhPub.length !== DH_LEN) throw new SessionError("Malformed message.");
  return { suite, n: msg.n, pn: msg.pn, dh: dhPub, iv: msg.iv, ct: msg.ct };
}

interface PendingKey {
  id: string;
  key: Uint8Array;
}

/**
 * Advances a receiving chain from counter `from` up to (not including) `until`,
 * collecting the message keys for the skipped counters.
 */
function skipKeys(
  chain: Uint8Array,
  from: number,
  until: number,
  dhB64: string,
  pending: PendingKey[],
): Uint8Array {
  if (until - from > MAX_SKIP) {
    throw new SessionError(`Unexpected message counter ${until}: too many skipped messages.`);
  }
  let c = chain;
  for (let i = from; i < until; i++) {
    pending.push({ id: `${dhB64}:${i}`, key: chainStep(c, 0x01) });
    c = chainStep(c, 0x02);
  }
  return c;
}

interface DeriveParams {
  role: Role;
  myIdentity: Ed25519KeyPair;
  myEphemeral: EphemeralKeyPair;
  peerIdentityPublicKey: Uint8Array;
  peerEphemeralPublicKey: Uint8Array;
}

interface SessionState {
  rootKey: Uint8Array;
  dhs: EphemeralKeyPair;
  dhr: Uint8Array | null;
  sendChain: Uint8Array | null;
  recvChain: Uint8Array | null;
  sendDirection: number;
  recvDirection: number;
}

export class SecureSession {
  private rk: Uint8Array;
  private dhs: EphemeralKeyPair;
  private dhr: Uint8Array | null;
  private cks: Uint8Array | null;
  private ckr: Uint8Array | null;
  private ns = 0;
  private nr = 0;
  /** Length of the previous sending chain, sent in the header of a new chain. */
  private pn = 0;
  /** True after a DH ratchet step on receive: the next seal must rotate the sending key. */
  private needsRatchet = false;
  private readonly skipped = new Map<string, Uint8Array>();
  private readonly sendDirection: number;
  private readonly recvDirection: number;
  /** AEAD used for messages this side sends. Receiving accepts either suite. */
  private sendSuite: CipherSuite = DEFAULT_CIPHER_SUITE;

  private constructor(s: SessionState) {
    this.rk = s.rootKey;
    this.dhs = s.dhs;
    this.dhr = s.dhr;
    this.cks = s.sendChain;
    this.ckr = s.recvChain;
    this.sendDirection = s.sendDirection;
    this.recvDirection = s.recvDirection;
  }

  /** The suite used for the next messages this side sends. */
  get activeSuite(): CipherSuite {
    return this.sendSuite;
  }

  /**
   * Changes the suite for messages sent from now on. Both sides must agree on this
   * first (see suiteNegotiation.ts); the session itself does not check consent.
   * Keys and the ratchet are unchanged.
   */
  setSendSuite(suite: CipherSuite): void {
    this.sendSuite = suite;
  }

  static derive(p: DeriveParams): SecureSession {
    const myId = identityToX25519(p.myIdentity);
    const peerIdPub = ed25519.utils.toMontgomery(p.peerIdentityPublicKey);

    // Compute the two cross terms in a role-independent order.
    const idToPeerEph = dh(myId.secretKey, p.peerEphemeralPublicKey);
    const ephToPeerId = dh(p.myEphemeral.secretKey, peerIdPub);
    const ephToEph = dh(p.myEphemeral.secretKey, p.peerEphemeralPublicKey);

    const [dh1, dh2] =
      p.role === "initiator" ? [idToPeerEph, ephToPeerId] : [ephToPeerId, idToPeerEph];
    const ikm = concat(dh1, dh2, ephToEph);

    const myIdPub = p.myIdentity.publicKey;
    const peerIdPub32 = p.peerIdentityPublicKey;
    const myEphPub = p.myEphemeral.publicKey;
    const peerEphPub = p.peerEphemeralPublicKey;
    const transcript =
      p.role === "initiator"
        ? concat(myIdPub, peerIdPub32, myEphPub, peerEphPub)
        : concat(peerIdPub32, myIdPub, peerEphPub, myEphPub);
    const salt = sha256(transcript);

    const root = hkdf(sha256, ikm, salt, LABEL_ROOT, 32);
    const sendDirection = p.role === "initiator" ? 0x49 : 0x52; // 'I' / 'R'
    const recvDirection = p.role === "initiator" ? 0x52 : 0x49;

    if (p.role === "responder") {
      // The responder's ratchet key is its invitation ephemeral. It has no
      // sending chain until the initiator's first message arrives.
      return new SecureSession({
        rootKey: root,
        dhs: p.myEphemeral,
        dhr: null,
        sendChain: null,
        recvChain: null,
        sendDirection,
        recvDirection,
      });
    }

    // The initiator performs the first DH ratchet step now, so it can send first.
    const dhsInit = createEphemeralKeyPair();
    const [rootAfter, sendChain] = kdfRootKey(
      root,
      dh(dhsInit.secretKey, p.peerEphemeralPublicKey),
    );
    return new SecureSession({
      rootKey: rootAfter,
      dhs: dhsInit,
      dhr: p.peerEphemeralPublicKey,
      sendChain,
      recvChain: null,
      sendDirection,
      recvDirection,
    });
  }

  /** Encrypts one message and returns the JSON wire string. */
  async seal(plaintext: string): Promise<string> {
    if (plaintext.length > MAX_PLAINTEXT_CHARS) {
      throw new SessionError("Message is too long.");
    }
    if (this.needsRatchet && this.dhr !== null) {
      // Direction switch: fresh sending key, new sending chain.
      const dhsNew = createEphemeralKeyPair();
      const [rootAfter, sendChain] = kdfRootKey(this.rk, dh(dhsNew.secretKey, this.dhr));
      this.pn = this.ns;
      this.ns = 0;
      this.dhs = dhsNew;
      this.rk = rootAfter;
      this.cks = sendChain;
      this.needsRatchet = false;
    }
    if (this.cks === null) {
      throw new SessionError("Cannot send before the peer's first message arrives.");
    }

    const n = this.ns;
    const messageKey = chainStep(this.cks, 0x01);
    this.cks = chainStep(this.cks, 0x02);
    this.ns++;

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const suite = this.sendSuite;
    const aad = headerAad(suite, this.sendDirection, n, this.pn, this.dhs.publicKey);
    const ct = await aeadSeal(suite, messageKey, iv, aad, enc.encode(plaintext));
    return JSON.stringify({
      t: MSG_TYPE,
      s: suiteWireTag(suite),
      n,
      pn: this.pn,
      dh: bytesToBase64Url(this.dhs.publicKey),
      iv: bytesToBase64Url(iv),
      ct: bytesToBase64Url(ct),
    });
  }

  /**
   * Decrypts one wire message. Accepts out-of-order delivery within MAX_SKIP.
   * A replayed message (its key already used and deleted) is rejected.
   */
  async open(wire: string): Promise<string> {
    const m = parseWire(wire);
    const dhB64 = bytesToBase64Url(m.dh);

    // 1. A cached skipped key: use once, then delete.
    const cachedId = `${dhB64}:${m.n}`;
    const cachedKey = this.skipped.get(cachedId);
    if (cachedKey) {
      const pt = await this.decrypt(cachedKey, this.recvDirection, m);
      this.skipped.delete(cachedId);
      return pt;
    }

    // 2. Work on copies. Nothing is committed until the message authenticates.
    const pending: PendingKey[] = [];
    let rk = this.rk;
    let dhr = this.dhr;
    let ckr = this.ckr;
    let nr = this.nr;
    let needsRatchet = this.needsRatchet;
    const dhChanged = dhr === null || !bytesEqual(dhr, m.dh);

    if (dhChanged) {
      // DH ratchet step: first cache the rest of the old receiving chain.
      if (ckr !== null && dhr !== null) {
        ckr = skipKeys(ckr, nr, m.pn, bytesToBase64Url(dhr), pending);
      }
      nr = 0;
      dhr = m.dh;
      [rk, ckr] = kdfRootKey(rk, dh(this.dhs.secretKey, m.dh));
      needsRatchet = true;
    }

    if (ckr === null) {
      throw new SessionError("Unexpected message: no receiving chain yet.");
    }
    if (m.n < nr) {
      throw new SessionError(`Unexpected message counter ${m.n}, expected at least ${nr}.`);
    }

    // Cache keys for counters between the expected one and this message.
    ckr = skipKeys(ckr, nr, m.n, dhB64, pending);
    const messageKey = chainStep(ckr, 0x01);
    const nextRecvChain = chainStep(ckr, 0x02);

    const pt = await this.decrypt(messageKey, this.recvDirection, m);

    // Commit.
    this.rk = rk;
    this.dhr = dhr;
    this.ckr = nextRecvChain;
    this.nr = m.n + 1;
    this.needsRatchet = needsRatchet;
    for (const p of pending) this.skipped.set(p.id, p.key);
    return pt;
  }

  private async decrypt(messageKey: Uint8Array, direction: number, m: ParsedMessage): Promise<string> {
    const aad = headerAad(m.suite, direction, m.n, m.pn, m.dh);
    let pt: Uint8Array;
    try {
      pt = await aeadOpen(m.suite, messageKey, base64UrlToBytes(m.iv), aad, base64UrlToBytes(m.ct));
    } catch {
      throw new SessionError("Message failed authentication.");
    }
    return new TextDecoder().decode(pt);
  }
}

/** True if a channel string looks like an encrypted application message. */
export function isEncryptedMessage(text: string): boolean {
  return text.startsWith('{"t":"msg"');
}
