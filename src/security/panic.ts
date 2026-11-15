/**
 * Panic wipe (Н7): one confirmed tap empties this device at once.
 *
 *  - Every IndexedDB store is cleared in one transaction (transfer/wipe.ts), after background
 *    writers (the group) are stopped, so nothing writes keys back afterwards. The identity
 *    record holds the only wrapped copy of the seed on this device: without it the history
 *    and the contact book, which are encrypted with keys derived from the seed, cannot be read
 *    even if their bytes are still somewhere on the disk.
 *  - Files paused half-way (in memory) are forgotten and their keys zeroed.
 *  - This app's settings in localStorage go too, except the language.
 *
 * What it cannot do (docs/SECURITY-DEVICE.md): remove the passkey from the system password
 * manager (useless without the record), reach copies on the other person's device, or undo
 * the 12 words: whoever has them can restore the identity (not the history) on a new device.
 */
import { parkedFiles } from "../p2p/fileTransfer";
import { stopWritersAndWipe, type BackgroundWriter } from "../transfer/wipe";

/** Kept after a wipe: the language says nothing about the person. */
const KEEP = new Set(["p2p.lang"]);

type KeyedStore = Pick<Storage, "length" | "key" | "removeItem">;

/** Removes this app's localStorage entries (p2p.* and p2p-*), except KEEP. */
export function clearAppSettings(s: KeyedStore | null = safeLocalStorage()): void {
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && /^p2p[.-]/.test(k) && !KEEP.has(k)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    /* storage blocked: nothing of ours is in it */
  }
}

function safeLocalStorage(): KeyedStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export async function panicWipe(writers: Iterable<BackgroundWriter | null | undefined>): Promise<void> {
  parkedFiles.clear();
  await stopWritersAndWipe(writers);
  clearAppSettings();
  try {
    sessionStorage.clear();
  } catch {
    /* not available */
  }
}
