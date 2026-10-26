/**
 * Empties this device after a completed move: identity, contacts (both stores), messages,
 * files, groups. Every store is cleared in ONE transaction, so a crash leaves either
 * everything or nothing. Message history is not transferred (docs/MULTIDEVICE.md), so it goes
 * with the old device; without the seed it could not be read anyway.
 */
import { openDatabase } from "../db/database";

export async function wipeThisDevice(): Promise<void> {
  const db = await openDatabase();
  try {
    const stores = Array.from(db.objectStoreNames);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of stores) tx.objectStore(name).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Something that writes to the database in the background (a group session). */
export interface BackgroundWriter {
  /** Stops new work (links, auto-linking). Saves already queued may still run. */
  closeAll(): void;
  /** Resolves once every queued save has been written. */
  flush(): Promise<void>;
}

/**
 * Stops every background writer and waits for its queued saves BEFORE clearing the stores.
 * Otherwise a save that was still encrypting would open its write transaction after the wipe
 * and put group keys back on a device that is supposed to be empty.
 */
export async function stopWritersAndWipe(writers: Iterable<BackgroundWriter | null | undefined>): Promise<void> {
  const live = [...writers].filter((w): w is BackgroundWriter => !!w);
  for (const w of live) w.closeAll();
  await Promise.all(live.map((w) => w.flush().catch(() => undefined)));
  await wipeThisDevice();
}
