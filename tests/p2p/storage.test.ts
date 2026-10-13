import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DB_NAME } from "../../src/db/database";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import type { UnlockedIdentity } from "../../src/identity/types";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import {
  deleteContact,
  getContact,
  listContacts,
  renameContact,
  saveContact,
  type Contact,
} from "../../src/contacts/contacts";
import { appendMessage, deriveHistoryKey, loadHistory } from "../../src/history/messageStore";

function freshDb() {
  // @ts-expect-error - replace the global factory with an empty in-memory one
  globalThis.indexedDB = new IDBFactory();
}

function makeIdentity(): UnlockedIdentity {
  const keyPair = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  return { did: publicKeyToDidKey(keyPair.publicKey), keyPair };
}

function contact(seed: UnlockedIdentity, name: string, addedAt: number): Contact {
  return {
    did: seed.did,
    publicKey: seed.keyPair.publicKey,
    name,
    verified: true,
    verifiedAt: addedAt,
    addedAt,
  };
}

beforeEach(() => {
  freshDb();
});

describe("contacts", () => {
  it("saves, reads, lists (newest first), renames and deletes", async () => {
    const a = makeIdentity();
    const b = makeIdentity();
    await saveContact(contact(a, "Алиса", 1000));
    await saveContact(contact(b, "Боб", 2000));

    expect((await getContact(a.did))?.name).toBe("Алиса");
    expect((await listContacts()).map((c) => c.name)).toEqual(["Боб", "Алиса"]);

    await renameContact(a.did, "  Алиса М.  ");
    expect((await getContact(a.did))?.name).toBe("Алиса М.");

    await deleteContact(b.did);
    expect(await getContact(b.did)).toBeNull();
    expect(await listContacts()).toHaveLength(1);
  });

  it("returns null for an unknown contact", async () => {
    expect(await getContact("did:key:zUnknown")).toBeNull();
  });
});

describe("encrypted message history", () => {
  it("round-trips messages for one peer, ordered by time", async () => {
    const me = makeIdentity();
    const key = deriveHistoryKey(me);
    const peer = makeIdentity().did;

    await appendMessage(key, peer, { text: "втори", direction: "in", timestamp: 2000 });
    await appendMessage(key, peer, { text: "първи", direction: "out", timestamp: 1000 });

    const history = await loadHistory(key, peer);
    expect(history.map((m) => m.text)).toEqual(["първи", "втори"]);
    expect(history.map((m) => m.direction)).toEqual(["out", "in"]);
  });

  it("keeps histories of different peers separate", async () => {
    const me = makeIdentity();
    const key = deriveHistoryKey(me);
    const p1 = makeIdentity().did;
    const p2 = makeIdentity().did;
    await appendMessage(key, p1, { text: "to p1", direction: "out", timestamp: 1 });
    await appendMessage(key, p2, { text: "to p2", direction: "out", timestamp: 2 });

    expect((await loadHistory(key, p1)).map((m) => m.text)).toEqual(["to p1"]);
    expect((await loadHistory(key, p2)).map((m) => m.text)).toEqual(["to p2"]);
  });

  it("stores ciphertext only: the raw record does not contain the plaintext", async () => {
    const me = makeIdentity();
    const key = deriveHistoryKey(me);
    const peer = makeIdentity().did;
    await appendMessage(key, peer, { text: "very secret phrase", direction: "in", timestamp: 5 });

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction("messages", "readonly").objectStore("messages").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("very secret phrase");
  });

  it("cannot be read with a different identity's key", async () => {
    const me = makeIdentity();
    const intruder = makeIdentity();
    const peer = makeIdentity().did;
    await appendMessage(deriveHistoryKey(me), peer, { text: "x", direction: "in", timestamp: 1 });
    await expect(loadHistory(deriveHistoryKey(intruder), peer)).rejects.toThrow();
  });
});
