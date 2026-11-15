/**
 * Н2 on/off, per device (localStorage `p2p.rv`). Off by default: it uses public Nostr relays,
 * which see this device's IP address and when it publishes (docs/THREAT_MODEL.md).
 */
import { DEFAULT_RELAYS } from "./relays";

const KEY = "p2p.rv";
export const RV_EVENT = "p2p-rv-settings";

export function rendezvousEnabled(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}").enabled === true;
  } catch {
    return false;
  }
}

export function setRendezvousEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled }));
  } catch {
    /* private mode: on for this session only */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RV_EVENT));
}

/** The relays this build uses: VITE_NOSTR_RELAYS (comma separated, tests) or the defaults. */
export function configuredRelays(): string[] {
  const env = (import.meta.env?.VITE_NOSTR_RELAYS as string | undefined) ?? "";
  const list = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/[^\s/]+/.test(s));
  return list.length ? list : DEFAULT_RELAYS;
}
