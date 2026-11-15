/**
 * Application-level handshake over an open data channel.
 *
 * Each side sends a `hello` carrying its did:key. The receiving side checks
 * that the did matches the public key it already verified from the signed
 * invitation. A mismatch means the channel is not the peer whose QR was
 * scanned, and the link is torn down.
 *
 * Messages are plain JSON in this phase. Message encryption (libsignal) comes
 * in the messaging phase; the DTLS channel already encrypts traffic in transit.
 */
import { publicKeyToDidKey } from "../identity/didKey";
import type { PeerLink } from "./peer";
import { CAPABILITIES, PROTOCOL_VERSION, readPeerProtocol, type PeerProtocol } from "./protocol";

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

interface HelloMessage {
  t: "hello";
  did: string;
  /** Protocol version and capabilities (protocol.ts). Absent from pv 1 clients. */
  pv?: number;
  caps?: string[];
}

function parseHello(text: string): { did: string; peer: PeerProtocol } | null {
  try {
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg && msg.t === "hello" && typeof msg.did === "string") {
      return { did: msg.did, peer: readPeerProtocol(msg) };
    }
  } catch {
    /* not JSON: ignore */
  }
  return null;
}

/** A link that remembers what the other side said it supports (PeerLink has this field). */
interface WithPeerProtocol {
  peerProtocol?: PeerProtocol;
}

/**
 * Resolves with the verified peer did once the peer's hello matches
 * `expectedPeerPublicKey`. Rejects on mismatch, timeout, or channel failure.
 */
export async function completeHandshake(
  link: Pick<PeerLink, "onMessage" | "waitForOpen" | "send"> & WithPeerProtocol,
  myDid: string,
  expectedPeerPublicKey: Uint8Array,
  timeoutMs?: number,
): Promise<string> {
  const expectedDid = publicKeyToDidKey(expectedPeerPublicKey);

  const peerHello = new Promise<string>((resolve, reject) => {
    const unsubscribe = link.onMessage((text) => {
      const hello = parseHello(text);
      if (!hello) return;
      unsubscribe();
      if (hello.did !== expectedDid) {
        reject(new HandshakeError("Peer identity does not match the scanned invitation."));
        return;
      }
      link.peerProtocol = hello.peer;
      resolve(hello.did);
    });
  });
  // Keep a rejection from surfacing as unhandled if the race below already settled.
  peerHello.catch(() => undefined);

  await link.waitForOpen(timeoutMs);
  link.send(JSON.stringify({ t: "hello", did: myDid, pv: PROTOCOL_VERSION, caps: [...CAPABILITIES] } satisfies HelloMessage));
  return peerHello;
}
