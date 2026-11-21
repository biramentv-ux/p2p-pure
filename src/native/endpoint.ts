/**
 * П4 (experiment): how the two sides tell each other their native UDP endpoint. One extra SDP
 * line in the invitation and the answer, inside the signed SDP:
 *
 *   a=x-p2p-native:1 203.0.113.20 40123 symmetric
 *
 * It is removed again before the SDP reaches RTCPeerConnection (browsers would ignore it, but
 * there is no reason to rely on that). The key for punching and for the datagram link comes from
 * the two ephemeral X25519 keys that are already in the signed invitations, so only the two
 * people who exchanged them can use the hole that opens.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { NatKind } from "./punch";

export interface NativeEndpoint {
  host: string;
  port: number;
  nat: NatKind;
}

const PREFIX = "a=x-p2p-native:1 ";
const LINE = /^a=x-p2p-native:1 (\S+) (\d{1,5}) (cone|symmetric|unknown)\s*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function addNativeLine(sdp: string, e: NativeEndpoint): string {
  if (!IPV4.test(e.host) || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new Error("bad native endpoint");
  const body = stripNativeLines(sdp).replace(/\r?\n$/, "");
  return `${body}\r\n${PREFIX}${e.host} ${e.port} ${e.nat}\r\n`;
}

/** The endpoint in an SDP, or null (no line, or one that does not parse). */
export function readNativeLine(sdp: string): NativeEndpoint | null {
  for (const raw of sdp.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue;
    const port = Number(m[2]);
    if (!IPV4.test(m[1]) || port < 1 || port > 65535) return null;
    return { host: m[1], port, nat: m[3] as NatKind };
  }
  return null;
}

export function stripNativeLines(sdp: string): string {
  if (!sdp.includes("a=x-p2p-native:")) return sdp;
  return sdp
    .split(/(?<=\n)/)
    .filter((l) => !l.startsWith("a=x-p2p-native:"))
    .join("");
}

/**
 * The shared secret for the native transport, the same on both sides: X25519 of the two
 * ephemeral keys from the signed invitations, bound to the offer's nonce.
 */
export function nativeSecret(myEphemeralSecret: Uint8Array, peerEphemeralPublic: Uint8Array, offerNonce: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myEphemeralSecret, peerEphemeralPublic);
  return hkdf(sha256, shared, offerNonce, new TextEncoder().encode("p2p-native/secret/v1"), 32);
}
