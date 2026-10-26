/**
 * Local contact book, encrypted at rest. A contact is `verified` only after both sides
 * compared the safety code and the user confirmed. Unverified contacts are never stored.
 *
 * Storage (DB v5, store `contactsSealed`): one row per contact, `{ id, iv, ct }`.
 *   - `id`  = hex HMAC-SHA-256(macKey, did). The DID itself is not visible; only someone with
 *             the key can test whether a given DID is in the book. Every lookup in the app
 *             starts from a DID it already has, so the HMAC is enough for get/put/delete.
 *   - `ct`  = AES-256-GCM over the whole JSON record (DID, public key, name, verified flag,
 *             timestamps), 12-byte random IV, AAD = "p2p-contacts/v1|contactsSealed|<id>",
 *             so a row cannot be moved under another id.
 * Both keys are derived with HKDF (WebCrypto) from the history key, which itself only exists
 * in memory after unlock. While locked every call throws ContactsLockedError.
 *
 * The pre-v5 plaintext store `contacts` is migrated by `unlockContacts` on the first unlock:
 * rows are encrypted, then written to the sealed store and deleted from the plaintext store
 * in one transaction, so a crash leaves either the old or the new copy, never neither.
 */
import { asBufferSource } from "../identity/bufferUtils";
import { STORE_CONTACTS, STORE_CONTACTS_SEALED, openDatabase, withStore } from "../db/database";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";

export interface Contact {
  did: string;
  publicKey: Uint8Array;
  name: string;
  verified: boolean;
  verifiedAt?: number;
  addedAt: number;
}

export class ContactsLockedError extends Error {
  constructor() {
    super("Contacts are locked: unlock the identity first.");
    this.name = "ContactsLockedError";
  }
}

interface SealedRow {
  id: string;
  iv: string;
  ct: string;
}

interface Keys {
  aes: CryptoKey;
  mac: CryptoKey;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const AES_INFO = enc.encode("p2p-messenger/contacts/aes/v1");
const MAC_INFO = enc.encode("p2p-messenger/contacts/id-mac/v1");

let keys: Keys | null = null;

export async function deriveContactKeys(historyKey: Uint8Array): Promise<Keys> {
  const base = await crypto.subtle.importKey("raw", asBufferSource(historyKey), "HKDF", false, ["deriveKey"]);
  const params = (info: Uint8Array): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: asBufferSource(info),
  });
  const aes = await crypto.subtle.deriveKey(params(AES_INFO), base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const mac = await crypto.subtle.deriveKey(params(MAC_INFO), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [
    "sign",
  ]);
  return { aes, mac };
}

function need(): Keys {
  if (!keys) throw new ContactsLockedError();
  return keys;
}

async function rowId(k: Keys, did: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k.mac, asBufferSource(enc.encode(did))));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

function aad(id: string): Uint8Array {
  return enc.encode(`p2p-contacts/v1|${STORE_CONTACTS_SEALED}|${id}`);
}

function toJson(c: Contact): string {
  return JSON.stringify({
    did: c.did,
    pk: bytesToBase64Url(c.publicKey),
    name: c.name,
    verified: c.verified,
    verifiedAt: c.verifiedAt,
    addedAt: c.addedAt,
  });
}

function fromJson(text: string): Contact | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (typeof o.did !== "string" || typeof o.pk !== "string" || typeof o.name !== "string") return null;
    if (typeof o.verified !== "boolean" || typeof o.addedAt !== "number") return null;
    const c: Contact = {
      did: o.did,
      publicKey: base64UrlToBytes(o.pk),
      name: o.name,
      verified: o.verified,
      addedAt: o.addedAt,
    };
    if (typeof o.verifiedAt === "number") c.verifiedAt = o.verifiedAt;
    return c;
  } catch {
    return null;
  }
}

async function seal(k: Keys, c: Contact): Promise<SealedRow> {
  const id = await rowId(k, c.did);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv), additionalData: asBufferSource(aad(id)) },
    k.aes,
    asBufferSource(enc.encode(toJson(c))),
  );
  return { id, iv: bytesToBase64Url(iv), ct: bytesToBase64Url(new Uint8Array(ct)) };
}

/** Null when the row does not authenticate under this key or does not match its id. */
async function unseal(k: Keys, row: SealedRow): Promise<Contact | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(base64UrlToBytes(row.iv)), additionalData: asBufferSource(aad(row.id)) },
      k.aes,
      asBufferSource(base64UrlToBytes(row.ct)),
    );
    const c = fromJson(dec.decode(pt));
    if (!c || (await rowId(k, c.did)) !== row.id) return null;
    return c;
  } catch {
    return null;
  }
}

function isLegacy(v: unknown): v is Contact {
  const o = v as Partial<Contact> | null;
  // Every field fromJson() needs after decryption, or the sealed copy could never be read back.
  return (
    !!o &&
    typeof o.did === "string" &&
    ArrayBuffer.isView(o.publicKey) &&
    typeof o.name === "string" &&
    typeof o.verified === "boolean" &&
    typeof o.addedAt === "number" &&
    (o.verifiedAt === undefined || typeof o.verifiedAt === "number")
  );
}

/**
 * Moves every plaintext contact into the sealed store. Encryption happens before the write
 * transaction (WebCrypto is async and would let an IndexedDB transaction auto-commit), then
 * one readwrite transaction over both stores puts the sealed rows and deletes the plaintext
 * ones. Returns how many contacts were migrated.
 */
async function migrateLegacy(k: Keys): Promise<number> {
  const legacy = (await withStore<unknown[]>(STORE_CONTACTS, "readonly", (s) => s.getAll())) ?? [];
  if (legacy.length === 0) return 0;
  const moves: { did: string; row: SealedRow }[] = [];
  for (const v of legacy) {
    if (!isLegacy(v)) continue; // left in place: never delete what we could not move
    moves.push({ did: v.did, row: await seal(k, { ...v, publicKey: Uint8Array.from(v.publicKey) }) });
  }
  if (moves.length === 0) return 0;
  let moved = 0;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_CONTACTS, STORE_CONTACTS_SEALED], "readwrite");
      const out = tx.objectStore(STORE_CONTACTS_SEALED);
      const old = tx.objectStore(STORE_CONTACTS);
      // Another tab may have migrated (and the user since deleted or edited) a contact after
      // our snapshot was read: only a plaintext row that is still there is moved, so a stale
      // snapshot can never bring back or overwrite a contact.
      for (const m of moves) {
        const req = old.get(m.did);
        req.onsuccess = () => {
          if (!isLegacy(req.result)) return;
          out.put(m.row);
          old.delete(m.did);
          moved++;
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return moved;
}

/** Call after unlock (before any contact screen). Derives the keys and migrates old rows. */
export async function unlockContacts(historyKey: Uint8Array): Promise<number> {
  const k = await deriveContactKeys(historyKey);
  keys = k;
  return migrateLegacy(k);
}

/** Call on lock: drops the in-memory keys. */
export function lockContacts(): void {
  keys = null;
}

export function contactsUnlocked(): boolean {
  return keys !== null;
}

export async function saveContact(contact: Contact): Promise<void> {
  const row = await seal(need(), contact);
  await withStore(STORE_CONTACTS_SEALED, "readwrite", (s) => {
    s.put(row);
  });
}

export async function getContact(did: string): Promise<Contact | null> {
  const k = need();
  const id = await rowId(k, did);
  const row = await withStore<SealedRow | undefined>(STORE_CONTACTS_SEALED, "readonly", (s) => s.get(id));
  return row ? unseal(k, row) : null;
}

/** Every contact this key can open, newest first. Rows of another identity are skipped. */
export async function listContacts(): Promise<Contact[]> {
  const k = need();
  const rows = (await withStore<SealedRow[]>(STORE_CONTACTS_SEALED, "readonly", (s) => s.getAll())) ?? [];
  const out: Contact[] = [];
  for (const row of rows) {
    const c = await unseal(k, row);
    if (c) out.push(c);
  }
  return out.sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteContact(did: string): Promise<void> {
  const id = await rowId(need(), did);
  await withStore(STORE_CONTACTS_SEALED, "readwrite", (s) => {
    s.delete(id);
  });
}

export async function renameContact(did: string, name: string): Promise<void> {
  const c = await getContact(did);
  if (!c) return;
  await saveContact({ ...c, name: name.trim() || c.name });
}
