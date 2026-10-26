/**
 * Files kept on the device (up to MAX_STORED_FILE_BYTES each). The bytes are encrypted with
 * the history key, AES-256-GCM, with the file id and its owner (a contact's DID, or a group
 * slot) as associated data, so a record cannot be moved to another chat. Only the chat history
 * holds the file's card (name, size, type); the bytes are read when the person opens the file.
 */
import { asBufferSource } from "../identity/bufferUtils";
import { STORE_FILES, withStore } from "../db/database";
import { MAX_STORED_FILE_BYTES } from "../p2p/fileTransfer";

interface StoredFile {
  id: string;
  owner: string;
  mime: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

function aad(id: string, owner: string): Uint8Array {
  return new TextEncoder().encode(`p2p-messenger/file/v1|${owner}|${id}`);
}

async function key(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(raw), "AES-GCM", false, [usage]);
}

/** Can this file be kept? Larger files are shown only until the chat is closed. */
export function canStore(size: number): boolean {
  return size > 0 && size <= MAX_STORED_FILE_BYTES;
}

export async function saveFile(historyKey: Uint8Array, owner: string, id: string, blob: Blob): Promise<void> {
  if (!canStore(blob.size)) throw new Error("Файлът е твърде голям за пазене.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(iv), additionalData: asBufferSource(aad(id, owner)) },
      await key(historyKey, "encrypt"),
      await blob.arrayBuffer(),
    ),
  );
  const record: StoredFile = { id, owner, mime: blob.type, iv, ct };
  await withStore(STORE_FILES, "readwrite", (s) => {
    s.put(record);
  });
}

/** The file, or null if it was not kept (too big, deleted) or does not belong to this owner. */
export async function loadFile(historyKey: Uint8Array, owner: string, id: string): Promise<Blob | null> {
  const row = await withStore<StoredFile | undefined>(STORE_FILES, "readonly", (s) => s.get(id));
  if (!row || row.owner !== owner) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(row.iv), additionalData: asBufferSource(aad(id, owner)) },
      await key(historyKey, "decrypt"),
      asBufferSource(row.ct),
    );
    return new Blob([pt], { type: row.mime });
  } catch {
    return null;
  }
}

/** Deletes every kept file of a chat (used when the chat is wiped or a group is left). */
export async function deleteFilesFor(owner: string): Promise<void> {
  const keys =
    (await withStore<IDBValidKey[]>(STORE_FILES, "readonly", (s) => s.index("byOwner").getAllKeys(IDBKeyRange.only(owner)))) ?? [];
  if (keys.length === 0) return;
  await withStore(STORE_FILES, "readwrite", (s) => {
    for (const k of keys) s.delete(k);
  });
}
