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

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

interface HelloMessage {
  t: "hello";
  did: string;
}

function parseHello(text: string): HelloMessage | null {
  try {
    const msg = JSON.parse(text) as Partial<HelloMessage>;
    if (msg && msg.t === "hello" && typeof msg.did === "string") {
      return { t: "hello", did: msg.did };
    }
  } catch {
    /* not JSON: ignore */
  }
  return null;
}

/**
 * Resolves with the verified peer did once the peer's hello matches
 * `expectedPeerPublicKey`. Rejects on mismatch, timeout, or channel failure.
 */
export async function completeHandshake(
  link: PeerLink,
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
      resolve(hello.did);
    });
  });
  // Keep a rejection from surfacing as unhandled if the race below already settled.
  peerHello.catch(() => undefined);

  await link.waitForOpen(timeoutMs);
  link.send(JSON.stringify({ t: "hello", did: myDid } satisfies HelloMessage));
  return peerHello;
}
