/**
 * TEST-ONLY reference Double Ratchet, written straight from the Signal specification
 * (https://signal.org/docs/specifications/doubleratchet/, sections 3.3-3.5 and 7.2).
 *
 * It is deliberately independent from src/p2p/secureSession.ts:
 *   - HKDF / HMAC / AEAD come from node:crypto (the production code uses @noble + WebCrypto);
 *   - the DH ratchet is "eager" as in the spec pseudocode (the new sending key is made
 *     right after a DH ratchet on receive), the production code does it lazily;
 *   - MAX_SKIP applies per chain and the total number of stored skipped keys is capped,
 *     as spec section 8.4 recommends.
 * Only the X25519 function and the Ed25519 -> X25519 map come from @noble/curves.
 *
 * The associated-data layout and the JSON wire format are application choices (the spec
 * leaves them open); they are copied from the documentation in secureSession.ts.
 * Never import this file from src/. It must not be part of any bundle.
 */
import { createCipheriv, createDecipheriv, createHmac, createHash, hkdfSync, randomBytes } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

export type RefSuite = "a" | "c";

const LABEL_ROOT = "p2p-messenger/session/root/v1";
const LABEL_RATCHET = "p2p-messenger/session/ratchet/v2";

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string | Uint8Array, len: number): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", ikm, salt, typeof info === "string" ? Buffer.from(info) : info, len));
}
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}
export const sha256 = (d: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(d).digest());

/** Spec 7.2: KDF_RK = HKDF(salt = rk, ikm = dh_out, info = app constant) -> (rk', ck). */
export function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdfSha256(dhOut, rk, LABEL_RATCHET, 64);
  return [out.slice(0, 32), out.slice(32)];
}
/** Spec 7.2: KDF_CK = HMAC(ck, 0x01) -> message key, HMAC(ck, 0x02) -> next chain key. */
export function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [hmacSha256(ck, Uint8Array.of(0x01)), hmacSha256(ck, Uint8Array.of(0x02))];
}

const cat = (...p: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(p));

/** Independent re-implementation of the session's initial root key (X3DH-style). */
export function refRootKey(p: {
  role: "initiator" | "responder";
  myIdentity: { secretKey: Uint8Array; publicKey: Uint8Array };
  myEphemeral: { secretKey: Uint8Array; publicKey: Uint8Array };
  peerIdentityPublicKey: Uint8Array;
  peerEphemeralPublicKey: Uint8Array;
}): Uint8Array {
  const mySk = ed25519.utils.toMontgomerySecret(p.myIdentity.secretKey);
  const peerIdX = ed25519.utils.toMontgomery(p.peerIdentityPublicKey);
  const idEph = x25519.getSharedSecret(mySk, p.peerEphemeralPublicKey);
  const ephId = x25519.getSharedSecret(p.myEphemeral.secretKey, peerIdX);
  const ephEph = x25519.getSharedSecret(p.myEphemeral.secretKey, p.peerEphemeralPublicKey);
  const init = p.role === "initiator";
  const ikm = init ? cat(idEph, ephId, ephEph) : cat(ephId, idEph, ephEph);
  const transcript = init
    ? cat(p.myIdentity.publicKey, p.peerIdentityPublicKey, p.myEphemeral.publicKey, p.peerEphemeralPublicKey)
    : cat(p.peerIdentityPublicKey, p.myIdentity.publicKey, p.peerEphemeralPublicKey, p.myEphemeral.publicKey);
  return hkdfSha256(ikm, sha256(transcript), LABEL_ROOT, 32);
}

function aad(suite: RefSuite, dir: number, n: number, pn: number, dh: Uint8Array): Uint8Array {
  const out = Buffer.alloc(2 + 4 + 4 + 32);
  out[0] = suite === "a" ? 0x6d : 0x63;
  out[1] = dir;
  out.writeUInt32BE(n, 2);
  out.writeUInt32BE(pn, 6);
  Buffer.from(dh).copy(out, 10);
  return new Uint8Array(out);
}

function aeadSeal(suite: RefSuite, key: Uint8Array, iv: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array {
  const alg = suite === "a" ? "aes-256-gcm" : "chacha20-poly1305";
  const c = createCipheriv(alg, key, iv, { authTagLength: 16 });
  c.setAAD(ad);
  const body = Buffer.concat([c.update(pt), c.final()]);
  return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
}
function aeadOpen(suite: RefSuite, key: Uint8Array, iv: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array {
  const alg = suite === "a" ? "aes-256-gcm" : "chacha20-poly1305";
  const d = createDecipheriv(alg, key, iv, { authTagLength: 16 });
  d.setAAD(ad);
  d.setAuthTag(Buffer.from(ct.slice(ct.length - 16)));
  return new Uint8Array(Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]));
}

interface Pair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}
const newPair = (): Pair => {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

export class RefRatchet {
  RK: Uint8Array;
  DHs: Pair;
  DHr: Uint8Array | null;
  CKs: Uint8Array | null = null;
  CKr: Uint8Array | null = null;
  Ns = 0;
  Nr = 0;
  PN = 0;
  MKSKIPPED = new Map<string, Uint8Array>();
  constructor(
    sk: Uint8Array,
    DHs: Pair,
    DHr: Uint8Array | null,
    private readonly sendDir: number,
    private readonly recvDir: number,
    readonly maxSkip = 100,
    readonly maxTotalSkipped = 1000,
  ) {
    this.RK = sk;
    this.DHs = DHs;
    this.DHr = DHr;
    if (DHr) [this.RK, this.CKs] = kdfRk(sk, x25519.getSharedSecret(DHs.secretKey, DHr)); // RatchetInitAlice
  }

  /** Spec RatchetInitAlice: sends first. `bobRatchetPub` is Bob's invitation ephemeral. */
  static initAlice(sk: Uint8Array, bobRatchetPub: Uint8Array, maxSkip?: number): RefRatchet {
    return new RefRatchet(sk, newPair(), bobRatchetPub, 0x49, 0x52, maxSkip);
  }
  /** Spec RatchetInitBob: its ratchet key pair is the invitation ephemeral. */
  static initBob(sk: Uint8Array, bobEphemeral: Pair, maxSkip?: number): RefRatchet {
    return new RefRatchet(sk, bobEphemeral, null, 0x52, 0x49, maxSkip);
  }

  encrypt(text: string, suite: RefSuite = "a"): string {
    if (this.CKs === null) throw new Error("ref: no sending chain");
    const [mk, next] = kdfCk(this.CKs);
    this.CKs = next;
    const n = this.Ns++;
    const iv = randomBytes(12);
    const ct = aeadSeal(suite, mk, iv, aad(suite, this.sendDir, n, this.PN, this.DHs.publicKey), Buffer.from(text));
    return JSON.stringify({ t: "msg", s: suite, n, pn: this.PN, dh: b64u(this.DHs.publicKey), iv: b64u(iv), ct: b64u(ct) });
  }

  private skip(until: number): void {
    if (this.Nr + this.maxSkip < until) throw new Error("ref: too many skipped");
    if (this.CKr === null) return;
    while (this.Nr < until) {
      const [mk, next] = kdfCk(this.CKr);
      this.CKr = next;
      this.MKSKIPPED.set(`${b64u(this.DHr!)}:${this.Nr}`, mk);
      this.Nr++;
    }
    if (this.MKSKIPPED.size > this.maxTotalSkipped) throw new Error("ref: skipped store full");
  }

  /** Spec RatchetDecrypt with full rollback when anything fails. */
  decrypt(wire: string): string {
    const m = JSON.parse(wire) as { s?: RefSuite; n: number; pn: number; dh: string; iv: string; ct: string };
    const suite: RefSuite = m.s ?? "a";
    const dh = unb64u(m.dh);
    const snap = {
      RK: this.RK, DHs: this.DHs, DHr: this.DHr, CKs: this.CKs, CKr: this.CKr,
      Ns: this.Ns, Nr: this.Nr, PN: this.PN, sk: new Map(this.MKSKIPPED),
    };
    try {
      const id = `${m.dh}:${m.n}`;
      const stored = this.MKSKIPPED.get(id);
      let mk: Uint8Array;
      if (stored) {
        mk = stored;
        this.MKSKIPPED.delete(id);
      } else {
        if (this.DHr === null || Buffer.compare(this.DHr, dh) !== 0) {
          this.skip(m.pn);
          this.PN = this.Ns;
          this.Ns = 0;
          this.Nr = 0;
          this.DHr = dh;
          [this.RK, this.CKr] = kdfRk(this.RK, x25519.getSharedSecret(this.DHs.secretKey, this.DHr));
          this.DHs = newPair();
          [this.RK, this.CKs] = kdfRk(this.RK, x25519.getSharedSecret(this.DHs.secretKey, this.DHr));
        }
        this.skip(m.n);
        if (this.CKr === null) throw new Error("ref: no receiving chain");
        let next: Uint8Array;
        [mk, next] = kdfCk(this.CKr);
        this.CKr = next;
        this.Nr++;
      }
      const pt = aeadOpen(suite, mk, unb64u(m.iv), aad(suite, this.recvDir, m.n, m.pn, dh), unb64u(m.ct));
      return Buffer.from(pt).toString("utf8");
    } catch (e) {
      Object.assign(this, { RK: snap.RK, DHs: snap.DHs, DHr: snap.DHr, CKs: snap.CKs, CKr: snap.CKr,
        Ns: snap.Ns, Nr: snap.Nr, PN: snap.PN, MKSKIPPED: snap.sk });
      throw e;
    }
  }
}
