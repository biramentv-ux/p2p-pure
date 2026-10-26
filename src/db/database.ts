/**
 * Single IndexedDB database for the app. Version 2 adds the `contacts` and
 * `messages` stores; upgrades from version 1 keep the existing `identity` data.
 * Version 3 adds `groups` and `groupMessages` (both hold only AES-GCM ciphertext,
 * see src/group/groupStore.ts); older stores are kept as they are.
 * Version 4 adds `files`: received and sent files up to 25 MB, each one AES-GCM encrypted
 * with the history key (src/history/fileStore.ts).
 * Version 5 adds `contactsSealed`: contacts encrypted with a key derived from the history
 * key, indexed by HMAC(DID) (src/contacts/contacts.ts). The old plaintext `contacts` store
 * stays only so its rows can be migrated on the first unlock; they are deleted as they move.
 */
export const DB_NAME = "p2p-messenger";
export const DB_VERSION = 5;

export const STORE_IDENTITY = "identity";
/** Legacy plaintext contacts (pre-v5). Read only by the migration, then emptied. */
export const STORE_CONTACTS = "contacts";
export const STORE_CONTACTS_SEALED = "contactsSealed";
export const STORE_MESSAGES = "messages";
export const STORE_GROUPS = "groups";
export const STORE_GROUP_MESSAGES = "groupMessages";
export const STORE_FILES = "files";

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
      if (!db.objectStoreNames.contains(STORE_CONTACTS_SEALED)) {
        db.createObjectStore(STORE_CONTACTS_SEALED, { keyPath: "id" });
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
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const files = db.createObjectStore(STORE_FILES, { keyPath: "id" });
        files.createIndex("byOwner", "owner", { unique: false });
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
