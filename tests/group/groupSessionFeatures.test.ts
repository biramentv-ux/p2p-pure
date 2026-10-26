import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deriveHistoryKey } from "../../src/history/messageStore";
import { GroupSession, MAX_GROUP_PHOTO_BYTES } from "../../src/group/groupSession";
import { loadGroupHistory, loadGroups } from "../../src/group/groupStore";
import { toDataUrl } from "../../src/p2p/photo";
import type { Contact } from "../../src/contacts/contacts";
import { connectedPair, fakeFactory, person, pngBytes, quiet, until, type Person } from "./fakeLinks";

// Real crypto on every hop and several hops per test: slow machines need more than 5 s.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

function keyOf(p: Person): Uint8Array {
  return deriveHistoryKey({ did: p.did, keyPair: p.keys });
}

function link(a: { p: Person; g: GroupSession }, b: { p: Person; g: GroupSession }) {
  const pair = connectedPair(a.p, b.p);
  a.g.attach(b.p.contact, pair.la, pair.sa);
  b.g.attach(a.p.contact, pair.lb, pair.sb);
  return pair;
}

/** Admin with Bob admitted, both saving to their own encrypted store. */
async function adminAndBob() {
  const admin = { p: person("Ани"), g: null as unknown as GroupSession };
  const bob = { p: person("Боб"), g: null as unknown as GroupSession };
  admin.g = GroupSession.create(admin.p.keys, "g-feat", "Приятели", "Ани", { historyKey: keyOf(admin.p) });
  bob.g = new GroupSession(bob.p.keys, { historyKey: keyOf(bob.p) });
  const pair = link(admin, bob);
  await admin.g.invite(bob.p.did, "Боб");
  await until(() => bob.g.snapshot.joined, "bob joined");
  return { admin, bob, pair };
}

describe("group session: survives a reload", () => {
  it("state, keys, role and history come back, and messages flow on new links", async () => {
    const { admin, bob } = await adminAndBob();
    await admin.g.sendText("преди презареждане");
    await until(() => bob.g.snapshot.messages.length === 1, "bob got it");
    await bob.g.sendText("отговор от Боб");
    await until(() => admin.g.snapshot.messages.length === 2, "admin got it");
    await admin.g.flush();
    await bob.g.flush();
    admin.g.closeAll();
    bob.g.closeAll();

    const admin2 = { p: admin.p, g: (await GroupSession.restore(admin.p.keys, keyOf(admin.p)))! };
    const bob2 = { p: bob.p, g: (await GroupSession.restore(bob.p.keys, keyOf(bob.p)))! };
    expect(admin2.g.snapshot.isAdmin).toBe(true);
    expect(bob2.g.snapshot.isAdmin).toBe(false);
    expect(bob2.g.snapshot.joined).toBe(true);
    expect(bob2.g.snapshot.state?.members.map((m) => m.name)).toEqual(["Ани", "Боб"]);
    expect(bob2.g.snapshot.messages.map((m) => [m.text, m.mine])).toEqual([
      ["преди презареждане", false],
      ["отговор от Боб", true],
    ]);

    link(admin2, bob2);
    await bob2.g.sendText("след презареждане");
    await until(() => admin2.g.snapshot.messages.some((m) => m.text === "след презареждане"), "after reload");
    await admin2.g.sendText("и от админа");
    await until(() => bob2.g.snapshot.messages.some((m) => m.text === "и от админа"), "admin after reload");
  });

  it("a member that reloads keeps talking to an admin that did not", async () => {
    const { admin, bob, pair } = await adminAndBob();
    await bob.g.sendText("първо");
    await until(() => admin.g.snapshot.messages.length === 1, "first");
    await bob.g.flush();
    bob.g.closeAll();
    pair.la.close();
    const bob2 = { p: bob.p, g: (await GroupSession.restore(bob.p.keys, keyOf(bob.p)))! };
    link(admin, bob2);
    await bob2.g.sendText("второ");
    await until(() => admin.g.snapshot.messages.length === 2, "second, not taken for a replay");
  });

  it("a member that is removed loses the stored keys and history", async () => {
    const { admin, bob } = await adminAndBob();
    await admin.g.sendText("съобщение");
    await until(() => bob.g.snapshot.messages.length === 1, "message");
    await bob.g.flush();
    expect(await loadGroups(keyOf(bob.p))).toHaveLength(1);
    await admin.g.remove(bob.p.did);
    await until(() => bob.g.snapshot.removed, "removed");
    await bob.g.flush();
    expect(await loadGroups(keyOf(bob.p))).toEqual([]);
    expect(await loadGroupHistory(keyOf(bob.p), "g-feat")).toEqual([]);
    expect(await GroupSession.restore(bob.p.keys, keyOf(bob.p))).toBeNull();
  });

  it("without a history key nothing is written", async () => {
    const admin = person("Ани");
    const g = GroupSession.create(admin.keys, "g-mem", "Само в паметта", "Ани");
    await g.flush();
    expect(await loadGroups(keyOf(admin))).toEqual([]);
  });
});

describe("group session: group photo", () => {
  it("the admin sets a photo; the member asks for it, checks the hash, shows and keeps it", async () => {
    const { admin, bob } = await adminAndBob();
    const bytes = pngBytes(6_000);
    await admin.g.setPhoto(bytes);
    expect(admin.g.snapshot.state?.photoHash).toBe(bytesToHex(sha256(bytes)));
    await until(() => bob.g.snapshot.photo !== null, "photo arrived");
    expect(bob.g.snapshot.photo).toBe(toDataUrl(bytes, "image/png"));
    await bob.g.flush();
    expect((await loadGroups(keyOf(bob.p)))[0].photo).toBe(toDataUrl(bytes, "image/png"));
    const bob2 = await GroupSession.restore(bob.p.keys, keyOf(bob.p));
    expect(bob2?.snapshot.photo).toBe(toDataUrl(bytes, "image/png"));
  });

  it("bytes that do not match the signed hash are refused", async () => {
    const { admin, bob } = await adminAndBob();
    const internals = admin.g as unknown as { photo: string | null; photoHash: string | null };
    // Drop Bob's link first, so his request can only go out on the new link below.
    bob.g.drop(admin.p.did);
    admin.g.drop(bob.p.did);
    await admin.g.setPhoto(pngBytes(3_000, 1));
    internals.photo = toDataUrl(pngBytes(3_000, 2), "image/png"); // the hash stays the honest one
    await quiet(50);
    link(admin, bob);
    await until(() => bob.g.snapshot.notices.some((n) => n.text.includes("не съвпада")), "mismatch notice");
    expect(bob.g.snapshot.photo).toBeNull();
  });

  it("a photo over the limit is refused by the admin and by the member", async () => {
    const { admin, bob } = await adminAndBob();
    await expect(admin.g.setPhoto(pngBytes(MAX_GROUP_PHOTO_BYTES + 1))).rejects.toThrow("твърде голяма");
    const internals = admin.g as unknown as { photo: string | null; photoHash: string | null };
    bob.g.drop(admin.p.did);
    admin.g.drop(bob.p.did);
    await admin.g.setPhoto(pngBytes(1_000));
    // A sender that ignores the limit: 400 kB, with the hash of those bytes in the snapshot.
    const big = pngBytes(400_000);
    internals.photo = toDataUrl(big, "image/png");
    internals.photoHash = bytesToHex(sha256(big));
    const chat = (admin.g as unknown as { mesh: { chat: { setPhoto(h: string): unknown } } }).mesh.chat;
    chat.setPhoto(internals.photoHash);
    link(admin, bob);
    await until(() => bob.g.snapshot.notices.some((n) => n.text === "Снимката на групата е твърде голяма."), "too large");
    expect(bob.g.snapshot.photo).toBeNull();
  });

  it("only the admin can set the photo, and a non-image is refused", async () => {
    const { admin, bob } = await adminAndBob();
    await expect(bob.g.setPhoto(pngBytes(100))).rejects.toThrow("Само създателят");
    await expect(admin.g.setPhoto(new Uint8Array(100).fill(1))).rejects.toThrow("не е валидна снимка");
  });

  it("photo frames nobody asked for are ignored", async () => {
    const { admin, bob } = await adminAndBob();
    await admin.g.setPhoto(pngBytes(2_000));
    await until(() => bob.g.snapshot.photo !== null, "photo");
    const before = bob.g.snapshot.photo;
    // The admin sends the same photo again without being asked (a misbehaving peer).
    const send = (admin.g as unknown as { sendPhotoTo(d: string, h: string): void }).sendPhotoTo.bind(admin.g);
    send(bob.p.did, admin.g.snapshot.state!.photoHash!);
    await quiet(100);
    expect(bob.g.snapshot.photoProgress).toBeNull();
    expect(bob.g.snapshot.photo).toBe(before);
  });
});

describe("group session: auto-linking through the admin", () => {
  async function trio(findContact?: (did: string) => Promise<Contact | null>) {
    const mk = (name: string) => ({ p: person(name), g: null as unknown as GroupSession });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const bob = mk("Боб");
    admin.g = GroupSession.create(admin.p.keys, "g-auto", "Тройка", "Ани", { linkFactory: fakeFactory, findContact });
    alice.g = new GroupSession(alice.p.keys, { linkFactory: fakeFactory, findContact });
    bob.g = new GroupSession(bob.p.keys, { linkFactory: fakeFactory, findContact });
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice joined");
    return { admin, alice, bob };
  }

  it("a new member is linked to the others without a QR code, and is admitted", async () => {
    const { admin, alice, bob } = await trio();
    link(admin, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob admitted");
    expect(alice.g.isLinked(bob.p.did)).toBe(true);
    expect(bob.g.isLinked(alice.p.did)).toBe(true);
    expect(admin.g.snapshot.state?.members).toHaveLength(3);

    // Linked through the admin: bound to the key, but nobody compared the safety code.
    expect(alice.g.snapshot.unverified).toEqual([bob.p.did]);
    expect(bob.g.snapshot.unverified).toEqual([alice.p.did]);
    expect(alice.g.contactOf(bob.p.did)?.verified).toBe(false);
    expect(alice.g.contactOf(bob.p.did)?.name).toBe("Боб");

    await bob.g.sendText("здрасти, Алиса");
    await until(() => alice.g.snapshot.messages.some((m) => m.text === "здрасти, Алиса"), "direct message");

    alice.g.markVerified(bob.p.did);
    expect(alice.g.snapshot.unverified).toEqual([]);
  });

  it("a peer that is already a verified contact shows as verified", async () => {
    const book = new Map<string, Contact>();
    const { admin, alice, bob } = await trio(async (did) => book.get(did) ?? null);
    book.set(bob.p.did, { ...bob.p.contact, name: "Боби" });
    link(admin, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => alice.g.isLinked(bob.p.did), "linked");
    expect(alice.g.snapshot.unverified).toEqual([]);
    expect(alice.g.contactOf(bob.p.did)?.verified).toBe(true);
  });

  it("a contact with the same DID but another key is not trusted as verified", async () => {
    const book = new Map<string, Contact>();
    const { admin, alice, bob } = await trio(async (did) => book.get(did) ?? null);
    book.set(bob.p.did, { ...bob.p.contact, publicKey: person("x").keys.publicKey });
    link(admin, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => alice.g.isLinked(bob.p.did), "linked");
    expect(alice.g.snapshot.unverified).toEqual([bob.p.did]);
  });

  it("after a reload, a member that links to the admin gets its other links back on its own", async () => {
    const { admin, alice, bob } = await trio();
    link(admin, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob admitted");

    // Bob "reloads": all his links are gone. He reconnects only to the admin.
    const chat = (bob.g as unknown as { mesh: { exportSecrets(): unknown } }).mesh.exportSecrets();
    bob.g.closeAll();
    const { GroupChat } = await import("../../src/group/groupChat");
    const bob2 = { p: bob.p, g: new GroupSession(bob.p.keys, { chat: GroupChat.restore(bob.p.keys, chat as never), linkFactory: fakeFactory }) };
    link(admin, bob2);
    await until(() => bob2.g.isLinked(alice.p.did), "relinked to alice");
    await bob2.g.sendText("отново тук");
    await until(() => alice.g.snapshot.messages.some((m) => m.text === "отново тук"), "message after relink");
  });

  it("without a link factory nothing is linked automatically", async () => {
    const admin = { p: person("Ани"), g: null as unknown as GroupSession };
    const alice = { p: person("Алиса"), g: null as unknown as GroupSession };
    const bob = { p: person("Боб"), g: null as unknown as GroupSession };
    admin.g = GroupSession.create(admin.p.keys, "g-manual", "Ръчно", "Ани");
    alice.g = new GroupSession(alice.p.keys);
    bob.g = new GroupSession(bob.p.keys);
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice");
    link(admin, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await quiet(200);
    expect(alice.g.isLinked(bob.p.did)).toBe(false);
    expect(bob.g.snapshot.joined).toBe(false);
  });
});
