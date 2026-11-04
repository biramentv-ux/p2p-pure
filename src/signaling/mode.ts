/**
 * Which signalling mode the user picked. Stored per device; the choice is not a secret.
 * Storage can be unavailable (private windows, blocked site data), so every access is guarded
 * and the default (local, no network) is used when it fails.
 *
 * "sound" = QR one way (offer) and the answer back as sound through the microphone.
 * A stored "ble" or "sound" choice is only a wish: the screen falls back to local
 * when the device cannot do it.
 */
export type SignalMode = "local" | "demo" | "ble" | "sound";

const MODES: readonly SignalMode[] = ["local", "demo", "ble", "sound"];

function isSignalMode(value: unknown): value is SignalMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

const STORAGE_KEY = "p2p-signal-mode";

export function getSignalMode(): SignalMode {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isSignalMode(stored) ? stored : "local";
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
