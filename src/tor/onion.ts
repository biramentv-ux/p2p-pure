/**
 * П6 (experiment): v3 onion addresses (rend-spec-v3 §6): base32(pubkey 32 || checksum 2 ||
 * version 1) + ".onion", checksum = SHA3-256(".onion checksum" || pubkey || version)[:2].
 * The address travels inside the signed invitation as one SDP line, like the native endpoint.
 */
import { sha3_256 } from "@noble/hashes/sha3.js";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const PREFIX = "a=x-p2p-onion:1 ";
const LINE = /^a=x-p2p-onion:1 ([a-z2-7]{56}\.onion)\s*$/;

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function checksum(pubkey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(".onion checksum");
  const msg = new Uint8Array(label.length + 33);
  msg.set(label, 0);
  msg.set(pubkey, label.length);
  msg[label.length + 32] = 3;
  return sha3_256(msg).slice(0, 2);
}

/** The address for an Ed25519 public key (used by tests; Arti makes the real one). */
export function onionFromKey(pubkey: Uint8Array): string {
  const c = checksum(pubkey);
  return base32Encode(Uint8Array.from([...pubkey, c[0], c[1], 3])) + ".onion";
}

/** A well-formed v3 address with a valid checksum. */
export function isOnionV3(addr: string): boolean {
  if (typeof addr !== "string" || !/^[a-z2-7]{56}\.onion$/.test(addr)) return false;
  const raw = base32Decode(addr.slice(0, 56));
  if (!raw || raw.length !== 35 || raw[34] !== 3) return false;
  const c = checksum(raw.subarray(0, 32));
  return c[0] === raw[32] && c[1] === raw[33];
}

export function addOnionLine(sdp: string, onion: string): string {
  if (!isOnionV3(onion)) throw new Error("bad onion address");
  const body = sdp
    .split(/(?<=\n)/)
    .filter((l) => !l.startsWith("a=x-p2p-onion:"))
    .join("")
    .replace(/\r?\n$/, "");
  return `${body}\r\n${PREFIX}${onion}\r\n`;
}

export function readOnionLine(sdp: string): string | null {
  for (const raw of sdp.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (m && isOnionV3(m[1])) return m[1];
  }
  return null;
}
