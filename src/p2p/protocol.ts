/**
 * Protocol version and capabilities (Н10, docs/PROTOCOL.md).
 *
 * Both are sent in the application `hello` (session.ts). A peer that sends neither is a
 * client from before version 2: it is treated as pv 1 with no capabilities, and the link
 * works as it always did. Capabilities only change what the app TELLS the person ("the other
 * side cannot continue a file"); no security check depends on them, because a peer can claim
 * anything here.
 */
export const PROTOCOL_VERSION = 2;

/** What this build can do beyond pv 1. */
export const CAPABILITIES = ["resume", "timer", "rv", "call2"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface PeerProtocol {
  pv: number;
  caps: Capability[];
}

export const LEGACY_PEER: PeerProtocol = { pv: 1, caps: [] };

/** Reads pv/caps from a parsed hello, ignoring anything unknown or malformed. */
export function readPeerProtocol(hello: Record<string, unknown>): PeerProtocol {
  const pv = typeof hello.pv === "number" && Number.isInteger(hello.pv) && hello.pv >= 1 && hello.pv < 1000 ? hello.pv : 1;
  const raw = Array.isArray(hello.caps) ? hello.caps.slice(0, 32) : [];
  const caps = [...new Set(raw.filter((c): c is Capability => (CAPABILITIES as readonly unknown[]).includes(c)))];
  return { pv, caps };
}

export function hasCap(peer: PeerProtocol | null | undefined, cap: Capability): boolean {
  return !!peer && peer.caps.includes(cap);
}
