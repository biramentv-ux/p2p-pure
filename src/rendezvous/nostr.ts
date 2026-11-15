/**
 * The few pieces of Nostr (NIP-01) the rendezvous needs: an event signed with a throwaway
 * secp256k1 key (BIP-340 Schnorr), and the client/relay message frames. No library beyond
 * @noble/curves, which the app already ships.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

/** Ephemeral range (20000–29999): relays pass these on and do not store them. */
export const RENDEZVOUS_KIND = 25050;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  kinds: number[];
  "#t": string[];
  since?: number;
}

function serialize(e: Omit<NostrEvent, "id" | "sig">): string {
  return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
}

/** Signs with a fresh key for every event, so two events cannot be linked by their author. */
export function signEvent(kind: number, tags: string[][], content: string, createdAt: number, secret: Uint8Array = randomBytes(32)): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const base = { pubkey, created_at: createdAt, kind, tags, content };
  const id = sha256(new TextEncoder().encode(serialize(base)));
  const sig = schnorr.sign(id, secret);
  secret.fill(0);
  return { ...base, id: bytesToHex(id), sig: bytesToHex(sig) };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Shape, id and signature (NIP-01). The rendezvous also authenticates the content itself. */
export function verifyEvent(e: unknown): e is NostrEvent {
  if (typeof e !== "object" || e === null) return false;
  const v = e as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.pubkey !== "string" || typeof v.sig !== "string") return false;
  if (!HEX64.test(v.id) || !HEX64.test(v.pubkey) || !/^[0-9a-f]{128}$/.test(v.sig)) return false;
  if (typeof v.created_at !== "number" || typeof v.kind !== "number" || typeof v.content !== "string") return false;
  if (!Array.isArray(v.tags) || !v.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return false;
  const id = bytesToHex(sha256(new TextEncoder().encode(serialize(v as unknown as NostrEvent))));
  if (id !== v.id) return false;
  try {
    return schnorr.verify(hexToBytes(v.sig), hexToBytes(id), hexToBytes(v.pubkey));
  } catch {
    return false;
  }
}

/** First "t" tag value. */
export function topicOf(e: NostrEvent): string | null {
  return e.tags.find((t) => t[0] === "t" && typeof t[1] === "string")?.[1] ?? null;
}

export type RelayMessage =
  | { type: "EVENT"; sub: string; event: unknown }
  | { type: "EOSE"; sub: string }
  | { type: "OK"; id: string; ok: boolean; message: string }
  | { type: "NOTICE"; message: string }
  | { type: "CLOSED"; sub: string; message: string };

export function parseRelayMessage(text: string): RelayMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(m) || typeof m[0] !== "string") return null;
  switch (m[0]) {
    case "EVENT":
      return typeof m[1] === "string" ? { type: "EVENT", sub: m[1], event: m[2] } : null;
    case "EOSE":
      return typeof m[1] === "string" ? { type: "EOSE", sub: m[1] } : null;
    case "OK":
      return typeof m[1] === "string" ? { type: "OK", id: m[1], ok: m[2] === true, message: String(m[3] ?? "") } : null;
    case "NOTICE":
      return { type: "NOTICE", message: String(m[1] ?? "") };
    case "CLOSED":
      return typeof m[1] === "string" ? { type: "CLOSED", sub: m[1], message: String(m[2] ?? "") } : null;
    default:
      return null;
  }
}
