import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveHistoryKey } from "../../src/history/messageStore";
import { DB_NAME, DB_VERSION, openDatabase, STORE_GROUP_MESSAGES, STORE_GROUPS, withStore } from "../../src/db/database";
import { GroupChat, COUNTER_RESTORE_GAP, type GroupSecrets } from "../../src/group/groupChat";
import {
  appendGroupMessage,
  deleteGroup,
  loadGroupHistory,
  loadGroups,
  photoUrlHash,
  saveGroup,
} from "../../src/group/groupStore";
import { toDataUrl } from "../../src/p2p/photo";
import { base64UrlToBytes, bytesToBase64Url } from "../../src/p2p/encoding";
import { person, pngBytes } from "./fakeLinks";

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

function keyOf(p: ReturnType<typeof person>): Uint8Array {
  return deriveHistoryKey({ did: p.did, keyPair: p.keys });
}

/** Everything IndexedDB holds in the two group stores, as one string. */
async function rawGroupData(): Promise<string> {
  const groups = await withStore<unknown[]>(STORE_GROUPS, "readonly", (s) => s.getAll());
  const messages = await withStore<unknown[]>(STORE_GROUP_MESSAGES, "readonly", (s) => s.getAll());
  return JSON.stringify([groups, messages]);
}

function adminGroup() {
  const admin = person("Ани");
  const bob = person("Боб");
  const chat = GroupChat.create(admin.keys, "grp-store", "Тайна група", "Ани");
  chat.admitMember({ did: bob.did, name: "Боб Тайнов" });
  return { admin, bob, chat };
}

describe("group store: state at rest", () => {
  it("saves and loads the group, and IndexedDB holds no name, member, DID or key in plaintext", async () => {
    const { admin, bob, chat } = adminGroup();
    const secrets = chat.exportSecrets();
    await saveGroup(keyOf(admin), secrets, null);

    const raw = await rawGroupData();
    expect(raw).not.toContain("Тайна група");
    expect(raw).not.toContain("Боб Тайнов");
    expect(raw).not.toContain(bob.did);
    expect(raw).not.toContain(admin.did);
    for (const k of secrets.keys) expect(raw).not.toContain(k.key);

    const [loaded] = await loadGroups(keyOf(admin));
    expect(loaded.secrets).toEqual(secrets);
    expect(loaded.photo).toBeNull();
  });

  it("another identity's key cannot open the record", async () => {
    const { admin, chat } = adminGroup();
    await saveGroup(keyOf(admin), chat.exportSecrets(), null);
    expect(await loadGroups(keyOf(person("Чужд")))).toEqual([]);
  });

  it("a changed or moved record does not authenticate and is skipped", async () => {
    const { admin, chat } = adminGroup();
    await saveGroup(keyOf(admin), chat.exportSecrets(), null);
    const [row] = (await withStore<Array<{ slot: string; groupId: string; iv: string; ct: string; updatedAt: number }>>(
      STORE_GROUPS,
      "readonly",
      (s) => s.getAll(),
    ))!;
    const owner = row.slot.split("|")[0];
    // The same ciphertext filed under another group id: the associated data no longer matches.
    await withStore(STORE_GROUPS, "readwrite", (s) => {
      s.delete(row.slot);
      s.put({ ...row, slot: `${owner}|друга`, groupId: "друга" });
    });
    expect(await loadGroups(keyOf(admin))).toEqual([]);
    // Flip one ciphertext byte of the original.
    const ct = base64UrlToBytes(row.ct);
    ct[5] ^= 1;
    await withStore(STORE_GROUPS, "readwrite", (s) => {
      s.clear();
      s.put({ ...row, ct: bytesToBase64Url(ct) });
    });
    expect(await loadGroups(keyOf(admin))).toEqual([]);
    // The untouched original still opens.
    await withStore(STORE_GROUPS, "readwrite", (s) => {
      s.put(row);
    });
    expect(await loadGroups(keyOf(admin))).toHaveLength(1);
  });

  it("keeps the photo only while its bytes match the signed hash", async () => {
    const { admin, chat } = adminGroup();
    const bytes = pngBytes(500);
    chat.setPhoto(bytesToHex(sha256(bytes)));
    const url = toDataUrl(bytes, "image/png");
    expect(photoUrlHash(url)).toBe(chat.snapshot.photoHash);

    await saveGroup(keyOf(admin), chat.exportSecrets(), url);
    expect((await loadGroups(keyOf(admin)))[0].photo).toBe(url);

    await saveGroup(keyOf(admin), chat.exportSecrets(), toDataUrl(pngBytes(500, 9), "image/png"));
    expect((await loadGroups(keyOf(admin)))[0].photo).toBeNull();
  });

  it("restore checks the creator's signature, the membership and the role", async () => {
    const { admin, bob, chat } = adminGroup();
    const secrets = chat.exportSecrets();
    expect(GroupChat.restore(admin.keys, secrets).snapshot).toEqual(chat.snapshot);

    const renamed: GroupSecrets = { ...secrets, snapshot: { ...secrets.snapshot, state: { ...secrets.snapshot.state, name: "Друго" } } };
    expect(() => GroupChat.restore(admin.keys, renamed)).toThrow(/повредена/);
    expect(() => GroupChat.restore(admin.keys, { ...secrets, role: "member" })).toThrow(/повредена/);
    expect(() => GroupChat.restore(bob.keys, secrets)).toThrow(/повредена/); // Bob is a member, but not the admin
    expect(() => GroupChat.restore(person("Чужд").keys, secrets)).toThrow(/Не сте участник/);
    expect(() => GroupChat.restore(admin.keys, { ...secrets, keys: [{ e: secrets.snapshot.state.epoch, key: "AAAA" }] })).toThrow(/повредена/);
    expect(() => GroupChat.restore(admin.keys, { ...secrets, keys: [] })).toThrow(/повредена/);
  });

  it("keeps only the current epoch key, and moves the counter ahead on restore", async () => {
    const { admin, chat } = adminGroup();
    await chat.seal("едно");
    await chat.seal("две");
    const secrets = chat.exportSecrets();
    expect(secrets.keys.map((k) => k.e)).toEqual([chat.snapshot.epoch]);
    expect(secrets.counter).toBe(2);
    const restored = GroupChat.restore(admin.keys, secrets);
    const next = await restored.seal("три");
    expect(next.n).toBe(2 + COUNTER_RESTORE_GAP);
  });

  it("deleteGroup removes the record and the whole history of that group only", async () => {
    const { admin, chat } = adminGroup();
    const key = keyOf(admin);
    await saveGroup(key, chat.exportSecrets(), null);
    await appendGroupMessage(key, "grp-store", { from: admin.did, text: "а", at: 1 });
    await appendGroupMessage(key, "other", { from: admin.did, text: "б", at: 2 });
    await deleteGroup(key, "grp-store");
    expect(await loadGroups(key)).toEqual([]);
    expect(await loadGroupHistory(key, "grp-store")).toEqual([]);
    expect((await loadGroupHistory(key, "other")).map((m) => m.text)).toEqual(["б"]);
  });
});

describe("group store: history at rest", () => {
  it("stores messages encrypted and loads them in order", async () => {
    const admin = person("Ани");
    const key = keyOf(admin);
    await appendGroupMessage(key, "g1", { from: "did:key:zB", text: "второ съобщение", at: 20 });
    await appendGroupMessage(key, "g1", { from: admin.did, text: "първо съобщение", at: 10 });
    const raw = await rawGroupData();
    expect(raw).not.toContain("съобщение");
    expect(raw).not.toContain("did:key:zB");
    const history = await loadGroupHistory(key, "g1");
    expect(history.map((m) => m.text)).toEqual(["първо съобщение", "второ съобщение"]);
    expect(history[0].from).toBe(admin.did);
  });

  it("loads only the newest messages up to the limit", async () => {
    const key = keyOf(person("Ани"));
    for (let i = 0; i < 5; i++) await appendGroupMessage(key, "g1", { from: "x", text: `m${i}`, at: i });
    expect((await loadGroupHistory(key, "g1", 2)).map((m) => m.text)).toEqual(["m3", "m4"]);
  });

  it("a message row moved to another group does not decrypt", async () => {
    const key = keyOf(person("Ани"));
    await appendGroupMessage(key, "g1", { from: "x", text: "тук", at: 1 });
    const [row] = (await withStore<Array<{ slot: string } & Record<string, unknown>>>(STORE_GROUP_MESSAGES, "readonly", (s) =>
      s.getAll(),
    ))!;
    const owner = row.slot.split("|")[0];
    await withStore(STORE_GROUP_MESSAGES, "readwrite", (s) => {
      s.put({ ...row, slot: `${owner}|g2` });
    });
    expect(await loadGroupHistory(key, "g2")).toEqual([]);
    expect(await loadGroupHistory(key, "g1")).toEqual([]);
  });

  it("two identities in one database keep their own records of the same group", async () => {
    const { admin, bob, chat } = adminGroup();
    const bobChat = GroupChat.restore(admin.keys, chat.exportSecrets()); // any valid secrets will do
    await saveGroup(keyOf(admin), chat.exportSecrets(), null);
    await saveGroup(keyOf(bob), bobChat.exportSecrets(), null);
    await appendGroupMessage(keyOf(admin), "grp-store", { from: admin.did, text: "на Ани", at: 1 });
    await appendGroupMessage(keyOf(bob), "grp-store", { from: bob.did, text: "на Боб", at: 2 });
    expect(await loadGroups(keyOf(admin))).toHaveLength(1);
    expect(await loadGroups(keyOf(bob))).toHaveLength(1);
    await deleteGroup(keyOf(bob), "grp-store");
    expect(await loadGroups(keyOf(admin))).toHaveLength(1);
    expect((await loadGroupHistory(keyOf(admin), "grp-store")).map((m) => m.text)).toEqual(["на Ани"]);
  });
});

describe("database upgrade", () => {
  it("version 3 adds the group stores and keeps the data of version 2", async () => {
    // A version 2 database, as the previous release left it.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("identity");
        db.createObjectStore("contacts", { keyPath: "did" });
        const m = db.createObjectStore("messages", { keyPath: "id" });
        m.createIndex("byPeer", "peerDid", { unique: false });
        m.put({ id: "old", peerDid: "did:x", direction: "in", timestamp: 1, iv: "", ct: "" });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const db = await openDatabase();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual(["contacts", "groupMessages", "groups", "identity", "messages"]);
    db.close();
    const old = await withStore<unknown>("messages", "readonly", (s) => s.get("old"));
    expect(old).toBeTruthy();
  });
});
