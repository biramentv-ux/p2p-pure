/**
 * П4 (experiment): the glue between the connect screen and the native transport, so the screen
 * only calls three functions:
 *
 *   prepareNative()   before the invitation is made: a socket and its public endpoint, or null
 *                     (the setting is off, a browser, no STUN answer within a few seconds);
 *   withNative()      the SDP with our endpoint line added (signed together with the invitation);
 *   armNativeLink()   once the peer's invitation is in: hands PeerLink the second way to open.
 *
 * Nothing here runs in a browser: without a native shell prepareNative() is always null.
 */
import { nativeBridge, type NativeBridge } from "./bridge";
import { addNativeLine, nativeSecret, readNativeLine, type NativeEndpoint } from "./endpoint";
import { connectNative, gatherNativeEndpoint, nativeTransportEnabled, punchInParallel } from "./nativeConnect";
import type { PunchSocket } from "./punch";
import type { PeerLink } from "../p2p/peer";
import { STUN_SERVERS } from "../p2p/turnConfig";

/** Our half: kept from prepareNative() until the link is armed or the attempt is dropped. */
export interface NativePrep {
  bridge: NativeBridge;
  endpoint: NativeEndpoint;
  socket: PunchSocket;
}

const GATHER_TIMEOUT_MS = 5000;

/** How long the responder keeps punching: it may have answered long before the initiator scans. */
export const NATIVE_RESPONDER_TIMEOUT_MS = 180_000;
export const NATIVE_INITIATOR_TIMEOUT_MS = 60_000;

function stunList(): string[] {
  const urls = STUN_SERVERS[0]?.urls;
  return Array.isArray(urls) ? urls : urls ? [urls] : [];
}

export async function prepareNative(): Promise<NativePrep | null> {
  if (!nativeTransportEnabled()) return null;
  const bridge = nativeBridge();
  if (!bridge) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gathering = gatherNativeEndpoint(bridge, stunList()).catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GATHER_TIMEOUT_MS);
  });
  const got = await Promise.race([gathering, timeout]);
  clearTimeout(timer);
  if (!got) {
    // Late answer after the timeout: close the socket it opened.
    void gathering.then((g) => g?.socket.close());
    return null;
  }
  return { bridge, endpoint: got.endpoint, socket: got.socket };
}

export function withNative(sdp: string, prep: NativePrep | null): string {
  return prep ? addNativeLine(sdp, prep.endpoint) : sdp;
}

export function dropNative(prep: NativePrep | null): void {
  prep?.socket.close();
}

/**
 * Arms the link when both invitations carry an endpoint; otherwise closes our socket.
 * `side`: the initiator is "A", the responder "B". The secret comes from the two ephemeral keys
 * of this pairing and the offer's nonce, so it is new for every connection.
 */
export function armNativeLink(
  link: PeerLink,
  prep: NativePrep | null,
  args: { side: "A" | "B"; peerSdp: string; myEphemeralSecret: Uint8Array; peerEphemeralPublic: Uint8Array; offerNonce: Uint8Array },
): boolean {
  if (!prep) return false;
  const peer = readNativeLine(args.peerSdp);
  if (!peer) {
    prep.socket.close();
    return false;
  }
  const secret = nativeSecret(args.myEphemeralSecret, args.peerEphemeralPublic, args.offerNonce);
  let cancelled = false;
  link.armNative({
    parallel: punchInParallel(prep.endpoint.nat, peer.nat),
    start: async () => {
      if (cancelled) throw new Error("cancelled");
      return connectNative({
        bridge: prep.bridge,
        socket: prep.socket,
        side: args.side,
        secret,
        me: prep.endpoint.nat,
        peer,
        timeoutMs: args.side === "A" ? NATIVE_INITIATOR_TIMEOUT_MS : NATIVE_RESPONDER_TIMEOUT_MS,
      });
    },
    cancel: () => {
      cancelled = true;
      prep.socket.close();
    },
  });
  return true;
}
