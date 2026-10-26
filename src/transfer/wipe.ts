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
