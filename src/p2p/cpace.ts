/**
 * CPace (draft-irtf-cfrg-cpace), ciphersuite CPACE-RISTR255-SHA512,
 * initiator-responder setting.
 *
 * NOTE: written from the draft's structure without access to the official
 * test vectors in this environment; see tests/p2p/cpace.test.ts.
 *
 * Flow: both sides derive a generator g from the password (PRS), channel
 * identifier (CI) and session id (sid), send Y = y*g, and compute K = y*Y_peer.
 * ISK hashes K together with the ordered transcript.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";

export class CpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpaceError";
  }
}

const Point = ristretto255.Point;
const DSI = new TextEncoder().encode("CPaceRistretto255");
const DSI_ISK = new TextEncoder().encode("CPaceRistretto255_ISK");
const S_IN_BYTES = 128; // SHA-512 input block size
const FIELD_SIZE_BYTES = 32;

export interface CpaceInput {
  prs: Uint8Array;
  ci: Uint8Array;
  sid: Uint8Array;
  ad?: Uint8Array;
}

export interface CpaceState {
  readonly role?: never;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** LEB128-style length prefix followed by the data. */
export function prependLen(data: Uint8Array): Uint8Array {
  const len: number[] = [];
  let n = data.length;
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    len.push(b);
  } while (n > 0);
  return concat(new Uint8Array(len), data);
}

export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concat(...parts.map(prependLen));
}

export function generatorString(
  dsi: Uint8Array,
  prs: Uint8Array,
  ci: Uint8Array,
  sid: Uint8Array,
  sInBytes: number = S_IN_BYTES,
): Uint8Array {
  const lenZpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(lenZpad), ci, sid);
}

export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) {
  const hash = sha512(generatorString(DSI, prs, ci, sid));
  const derive = ristretto255_hasher.deriveToCurve;
  if (!derive) throw new CpaceError("ristretto255 element derivation is unavailable.");
  return derive(hash);
}

function bytesToScalar(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n % Point.Fn.ORDER;
}

interface Internal {
  y: bigint | null;
  msg: Uint8Array; // lv_cat(Y, AD) as sent
  sid: Uint8Array;
  used: boolean;
}
const internals = new WeakMap<object, Internal>();

class State implements CpaceState {
  readonly role?: never;
}

export function cpaceStart(
  input: CpaceInput,
  random: (n: number) => Uint8Array = randomBytes,
): { msg: Uint8Array; state: CpaceState } {
  const g = calculateGenerator(input.prs, input.ci, input.sid);
  // 64 random bytes reduced mod the group order: negligible bias.
  const raw = random(2 * FIELD_SIZE_BYTES);
  if (raw.length < 2 * FIELD_SIZE_BYTES) throw new CpaceError("Not enough random bytes.");
  const y = bytesToScalar(raw.subarray(0, 2 * FIELD_SIZE_BYTES));
  if (y === 0n) throw new CpaceError("Sampled a zero scalar.");
  const Y = g.multiply(y).toBytes();
  const msg = lvCat(Y, input.ad ?? new Uint8Array(0));
  const state = new State();
  internals.set(state, { y, msg, sid: input.sid.slice(), used: false });
  return { msg, state };
}

/** Parses lv_cat(Y, AD): returns the two fields or throws. */
function parseMessage(msg: Uint8Array): { Y: Uint8Array; ad: Uint8Array } {
  const fields: Uint8Array[] = [];
  let i = 0;
  while (fields.length < 2) {
    let len = 0;
    let shift = 0;
    for (;;) {
      if (i >= msg.length || shift > 28) throw new CpaceError("Malformed CPace message.");
      const b = msg[i++];
      len += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    if (i + len > msg.length) throw new CpaceError("Malformed CPace message.");
    fields.push(msg.subarray(i, i + len));
    i += len;
  }
  if (i !== msg.length) throw new CpaceError("Malformed CPace message.");
  if (fields[0].length !== 32) throw new CpaceError("Invalid CPace point length.");
  return { Y: fields[0], ad: fields[1] };
}

export function cpaceFinish(
  state: CpaceState,
  peerMsg: Uint8Array,
  role: "initiator" | "responder",
): Uint8Array {
  const st = internals.get(state);
  if (!st || st.used || st.y === null) throw new CpaceError("CPace state is already used.");
  st.used = true;
  const y = st.y;
  st.y = null; // forget the scalar
  const peer = parseMessage(peerMsg);
  let Ypeer;
  try {
    Ypeer = Point.fromBytes(peer.Y);
  } catch {
    throw new CpaceError("Invalid CPace point encoding.");
  }
  const K = Ypeer.multiply(y);
  if (K.is0() || Ypeer.is0()) throw new CpaceError("CPace produced the identity element.");
  const transcript =
    role === "initiator" ? concat(st.msg, peerMsg) : concat(peerMsg, st.msg);
  return sha512(concat(lvCat(DSI_ISK, st.sid, K.toBytes()), transcript));
}
