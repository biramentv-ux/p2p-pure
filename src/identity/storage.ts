/**
 * Persistence for the single identity record.
 *
 * Exactly one identity per device (MVP). Only the ENCRYPTED seed touches disk;
 * the plaintext seed and derived private key live only in memory after unlock.
 */
import { STORE_IDENTITY, withStore } from "../db/database";
import type { IdentityRecord } from "./types";

const SINGLETON_KEY = "current";

export async function saveIdentityRecord(record: IdentityRecord): Promise<void> {
  await withStore(STORE_IDENTITY, "readwrite", (s) => {
    s.put(record, SINGLETON_KEY);
  });
}

export async function loadIdentityRecord(): Promise<IdentityRecord | null> {
  const result = await withStore<IdentityRecord | undefined>(STORE_IDENTITY, "readonly", (s) =>
    s.get(SINGLETON_KEY),
  );
  return result ?? null;
}

export async function clearIdentityRecord(): Promise<void> {
  await withStore(STORE_IDENTITY, "readwrite", (s) => {
    s.delete(SINGLETON_KEY);
  });
}

export async function hasIdentityRecord(): Promise<boolean> {
  return (await loadIdentityRecord()) !== null;
}
