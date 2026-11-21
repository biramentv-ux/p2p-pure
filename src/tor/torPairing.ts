/**
 * П6 (experiment): Tor from the connect screen's point of view, mirroring native/nativePairing.
 *
 * "Само през Tor" (onion-only): WebRTC gathers no candidates at all (relay-only policy with no
 * relay), so the device's IP address never leaves in the invitation and no connectivity check
 * goes out; the link opens only over the two onion services. The native transport is off then
 * (it would show the public address). Without the setting nothing here runs.
 */
import { addOnionLine, readOnionLine } from "./onion";
import { torBridge, type TorBridge } from "./torBridge";
import { openTorChannel, torKey } from "./torChannel";
import type { PeerLink } from "../p2p/peer";

const SETTING_KEY = "p2p-tor-only";

export function torOnlyEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTorOnlyEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    /* stays off */
  }
}

/** What RTCPeerConnection gets in onion-only mode: nothing to gather, nothing to try. */
export const TOR_ONLY_RTC: RTCConfiguration = { iceServers: [], iceTransportPolicy: "relay" };

export interface TorPrep {
  bridge: TorBridge;
  onion: string;
}

/** Onion-only and a shell with Tor: our onion address (bootstraps Tor the first time). */
export async function prepareTor(): Promise<TorPrep | null> {
  if (!torOnlyEnabled()) return null;
  const bridge = await torBridge();
  if (!bridge) return null;
  return { bridge, onion: await bridge.start() };
}

export function withOnion(sdp: string, prep: TorPrep | null): string {
  return prep ? addOnionLine(sdp, prep.onion) : sdp;
}

export const TOR_INITIATOR_TIMEOUT_MS = 180_000;
export const TOR_RESPONDER_TIMEOUT_MS = 300_000;

export function armTorLink(
  link: PeerLink,
  prep: TorPrep | null,
  args: { side: "A" | "B"; peerSdp: string; myEphemeralSecret: Uint8Array; peerEphemeralPublic: Uint8Array; offerNonce: Uint8Array },
): boolean {
  if (!prep) return false;
  const peerOnion = readOnionLine(args.peerSdp);
  if (!peerOnion) return false;
  const signal = { cancelled: false };
  link.armNative({
    parallel: true, // WebRTC has no candidates in this mode: nothing to wait for
    start: () =>
      openTorChannel({
        bridge: prep.bridge,
        side: args.side,
        key: torKey(args.myEphemeralSecret, args.peerEphemeralPublic, args.offerNonce),
        peerOnion,
        timeoutMs: args.side === "A" ? TOR_INITIATOR_TIMEOUT_MS : TOR_RESPONDER_TIMEOUT_MS,
        signal,
      }),
    cancel: () => {
      signal.cancelled = true;
    },
  });
  return true;
}

/** Bulgarian source text when one side is onion-only and the other is not (nothing can connect). */
export function torMismatch(prep: TorPrep | null, peerSdp: string): string | null {
  const peerTor = readOnionLine(peerSdp) !== null;
  if (prep && !peerTor) return "Ти си в режим „Само през Tor“, а другият човек не е. Нека и той го включи (само в настолното приложение с Tor) или изключи режима.";
  if (!prep && peerTor) return "Другият човек е в режим „Само през Tor“. Включи го и ти (само в настолното приложение с Tor), за да се свържете.";
  return null;
}
