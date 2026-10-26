import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DB_NAME, DB_VERSION, STORE_CONTACTS, STORE_CONTACTS_SEALED, openDatabase, withStore } from "../../src/db/database";
import {
  ContactsLockedError,
  deleteContact,
  getContact,
  listContacts,
  lockContacts,
  saveContact,
  unlockContacts,
  type Contact,
} from "../../src/contacts/contacts";

const NAME = "Тайна Алиса";
const DID = "did:key:z6MkSecretAliceDid000000000000000000000000000";

function contact(did: string, name: string, addedAt: number): Contact {
  return { did, publicKey: new Uint8Array([1, 2, 3, 4]), name, verified: true, verifiedAt: addedAt, addedAt };
}

async function rawRows(store: string): Promise<unknown[]> {
  return (await withStore<unknown[]>(store, "readonly", (s) => s.getAll())) ?? [];
}

/** A version 4 database as the previous release left it, with plaintext contacts. */
async function makeV4(contacts: Contact[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("identity");
      const c = db.createObjectStore("contacts", { keyPath: "did" });
      for (const x of contacts) c.put(x);
      db.createObjectStore("messages", { keyPath: "id" }).createIndex("byPeer", "peerDid", { unique: false });
      db.createObjectStore("groups", { keyPath: "slot" });
      db.createObjectStore("groupMessages", { keyPath: "id" }).createIndex("bySlot", "slot", { unique: false });
      db.createObjectStore("files", { keyPath: "id" }).createIndex("byOwner", "owner", { unique: false });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  // @ts-expect-error - fresh in-memory factory per test
  globalThis.indexedDB = new IDBFactory();
  lockContacts();
});

describe("contacts at rest", () => {
  it("the raw row holds no name, DID or timestamp in plaintext", async () => {
    await unlockContacts(crypto.getRandomValues(new Uint8Array(32)));
    await saveContact(contact(DID, NAME, 1_700_000_000_000));
    const rows = await rawRows(STORE_CONTACTS_SEALED);
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(NAME);
    expect(dump).not.toContain(DID);
    expect(dump).not.toContain("z6Mk");
    expect(dump).not.toContain("1700000000000");
    expect(Object.keys(rows[0] as object).sort()).toEqual(["ct", "id", "iv"]);
    expect((rows[0] as { id: string }).id).toMatch(/^[0-9a-f]{64}$/);
    expect(await rawRows(STORE_CONTACTS)).toHaveLength(0);
    expect((await getContact(DID))?.name).toBe(NAME);
  });

  it("throws while locked and another key cannot read the rows", async () => {
    await expect(listContacts()).rejects.toBeInstanceOf(ContactsLockedError);
    await expect(saveContact(contact(DID, NAME, 1))).rejects.toBeInstanceOf(ContactsLockedError);
    await unlockContacts(crypto.getRandomValues(new Uint8Array(32)));
    await saveContact(contact(DID, NAME, 1));
    lockContacts();
    await expect(getContact(DID)).rejects.toBeInstanceOf(ContactsLockedError);
    await unlockContacts(crypto.getRandomValues(new Uint8Array(32)));
    expect(await listContacts()).toEqual([]);
    expect(await getContact(DID)).toBeNull();
  });

  it("a row moved under another id does not authenticate", async () => {
    await unlockContacts(crypto.getRandomValues(new Uint8Array(32)));
    await saveContact(contact(DID, NAME, 1));
    await saveContact(contact("did:key:zOther", "Боб", 2));
    const rows = (await rawRows(STORE_CONTACTS_SEALED)) as { id: string; iv: string; ct: string }[];
    const [a, b] = rows;
    // Overwrite b's slot with a's ciphertext: the AAD binds a's ciphertext to a's id.
    await withStore(STORE_CONTACTS_SEALED, "readwrite", (s) => {
      s.put({ ...a, id: b.id });
    });
    // Only a's own (untouched) row is still readable.
    expect(await listContacts()).toHaveLength(1);
  });

  it("migrates v4 plaintext contacts on first unlock, without loss, and deletes the plaintext", async () => {
    const old = [contact(DID, NAME, 1000), contact("did:key:zBob", "Боб", 2000)];
    await makeV4(old);
    const db = await openDatabase();
    expect(db.version).toBe(DB_VERSION);
    db.close();
    // Still locked: plaintext stays, nothing is lost.
    expect(await rawRows(STORE_CONTACTS)).toHaveLength(2);
    expect(await rawRows(STORE_CONTACTS_SEALED)).toHaveLength(0);

    const key = crypto.getRandomValues(new Uint8Array(32));
    expect(await unlockContacts(key)).toBe(2);
    expect(await rawRows(STORE_CONTACTS)).toHaveLength(0);
    const sealedDump = JSON.stringify(await rawRows(STORE_CONTACTS_SEALED));
    expect(sealedDump).not.toContain(NAME);
    expect(sealedDump).not.toContain("Боб");

    const list = await listContacts();
    expect(list.map((c) => c.name)).toEqual(["Боб", NAME]);
    expect(list[1]).toEqual(old[0]);

    // Second unlock is a no-op.
    lockContacts();
    expect(await unlockContacts(key)).toBe(0);
    expect(await listContacts()).toHaveLength(2);
  });

  it("leaves malformed legacy rows in place instead of deleting them", async () => {
    await makeV4([contact(DID, NAME, 1)]);
    await withStore(STORE_CONTACTS, "readwrite", (s) => {
      s.put({ did: "did:key:zBroken", name: 5 });
    });
    expect(await unlockContacts(crypto.getRandomValues(new Uint8Array(32)))).toBe(1);
    expect(await rawRows(STORE_CONTACTS)).toHaveLength(1);
    expect(await listContacts()).toHaveLength(1);
  });

  it("keeps a legacy row that could be sealed but never read back (missing verified/addedAt)", async () => {
    await makeV4([contact(DID, NAME, 1)]);
    await withStore(STORE_CONTACTS, "readwrite", (s) => {
      s.put({ did: "did:key:zHalf", publicKey: new Uint8Array(32), name: "Половин" });
      s.put({ did: "did:key:zBadTime", publicKey: new Uint8Array(32), name: "Час", verified: false, addedAt: "вчера" });
    });
    expect(await unlockContacts(crypto.getRandomValues(new Uint8Array(32)))).toBe(1);
    expect(await rawRows(STORE_CONTACTS)).toHaveLength(2);
  });

  it("a second unlock racing the first never brings back a contact deleted in between", async () => {
    await makeV4([contact(DID, NAME, 1)]);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const [a, b] = await Promise.all([unlockContacts(key), unlockContacts(key)]);
    expect(a + b).toBe(1); // only one of them moved the row
    await deleteContact(DID);
    expect(await unlockContacts(key)).toBe(0);
    expect(await listContacts()).toHaveLength(0);
  });
});
