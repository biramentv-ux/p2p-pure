/**
 * Single IndexedDB database for the app. Version 2 adds the `contacts` and
 * `messages` stores; upgrades from version 1 keep the existing `identity` data.
 * Version 3 adds `groups` and `groupMessages` (both hold only AES-GCM ciphertext,
 * see src/group/groupStore.ts); older stores are kept as they are.
 */
export const DB_NAME = "p2p-messenger";
export const DB_VERSION = 3;

export const STORE_IDENTITY = "identity";
export const STORE_CONTACTS = "contacts";
export const STORE_MESSAGES = "messages";
export const STORE_GROUPS = "groups";
export const STORE_GROUP_MESSAGES = "groupMessages";

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
        db.createObjectStore(STORE_IDENTITY);
      }
      if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
        db.createObjectStore(STORE_CONTACTS, { keyPath: "did" });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
        messages.createIndex("byPeer", "peerDid", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS, { keyPath: "slot" });
      }
      if (!db.objectStoreNames.contains(STORE_GROUP_MESSAGES)) {
        const groupMessages = db.createObjectStore(STORE_GROUP_MESSAGES, { keyPath: "id" });
        groupMessages.createIndex("bySlot", "slot", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Runs one request inside a transaction and always closes the connection. */
export async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = run(tx.objectStore(store));
      let result: T | undefined;
      if (req) {
        req.onsuccess = () => {
          result = req.result as T;
        };
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
