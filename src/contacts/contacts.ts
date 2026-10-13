/**
 * Local contact book. A contact is `verified` only after both sides compared
 * the safety code and the user confirmed. Unverified contacts are never stored.
 */
import { STORE_CONTACTS, withStore } from "../db/database";

export interface Contact {
  did: string;
  publicKey: Uint8Array;
  name: string;
  verified: boolean;
  verifiedAt?: number;
  addedAt: number;
}

export async function saveContact(contact: Contact): Promise<void> {
  await withStore(STORE_CONTACTS, "readwrite", (s) => {
    s.put(contact);
  });
}

export async function getContact(did: string): Promise<Contact | null> {
  const c = await withStore<Contact | undefined>(STORE_CONTACTS, "readonly", (s) => s.get(did));
  return c ?? null;
}

export async function listContacts(): Promise<Contact[]> {
  const all = await withStore<Contact[]>(STORE_CONTACTS, "readonly", (s) => s.getAll());
  return (all ?? []).sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteContact(did: string): Promise<void> {
  await withStore(STORE_CONTACTS, "readwrite", (s) => {
    s.delete(did);
  });
}

export async function renameContact(did: string, name: string): Promise<void> {
  const c = await getContact(did);
  if (!c) return;
  await saveContact({ ...c, name: name.trim() || c.name });
}
