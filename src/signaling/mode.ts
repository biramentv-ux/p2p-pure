/**
 * Which signalling mode the user picked. Stored per device; the choice is not a secret.
 * Storage can be unavailable (private windows, blocked site data), so every access is guarded
 * and the default (local, no network) is used when it fails.
 */
export type SignalMode = "local" | "demo" | "ble";

const STORAGE_KEY = "p2p-signal-mode";

export function getSignalMode(): SignalMode {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored === "demo" || stored === "ble" ? stored : "local";
  } catch {
    return "local";
  }
}

export function setSignalMode(mode: SignalMode): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Not persisted: the mode lasts for this page only.
  }
}
