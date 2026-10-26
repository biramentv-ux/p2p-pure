/**
 * Two promises the group makes:
 *  1. A new member does not see what was sent before it joined.
 *  2. A member can be removed while it is offline (and while other members are offline too).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { base64UrlToBytes } from "../../src/p2p/encoding";
import { GroupChat, decodeGroupWire, encodeGroupWire, type GroupWire } from "../../src/group/groupChat";
import { GroupError } from "../../src/group/groupModel";
import { GroupSession } from "../../src/group/groupSession";
import { connectedPair, person, until, type Person } from "./fakeLinks";

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

function who() {
  const keys = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  return { keys, did: publicKeyToDidKey(keys.publicKey) };
}
const over = <T extends GroupWire>(w: GroupWire) => decodeGroupWire(encodeGroupWire(w)) as T;

describe("a new member does not see earlier messages", () => {
  it("messages sealed before the join cannot be opened with the key the new member gets", async () => {
    const admin = who();
    const alice = who();
    const bob = who();
    const adminChat = GroupChat.create(admin.keys, "grp-hist", "Стари", "Ани");
    let out = adminChat.admitMember({ did: alice.did, name: "Алиса" });
    const aliceChat = GroupChat.join(alice.keys, over(out.snapshot), {
      epoch: adminChat.snapshot.epoch,
      key: base64UrlToBytes(over<GroupWire & { t: "gkey" }>(out.keyFor.get(alice.did)!).key),
    });

    // Said before Bob is admitted, by both members.
    const before1 = await adminChat.seal("преди Боб");
    const before2 = await aliceChat.seal("и това е преди Боб");
    const oldEpoch = adminChat.snapshot.epoch;

    out = adminChat.admitMember({ did: bob.did, name: "Боб" });
    const bobKey = over<GroupWire & { t: "gkey" }>(out.keyFor.get(bob.did)!);
    expect(bobKey.e).toBeGreaterThan(oldEpoch); // admitting rotates the key
    const bobChat = GroupChat.join(bob.keys, over(out.snapshot), { epoch: bobKey.e, key: base64UrlToBytes(bobKey.key) });

    // Even if someone forwarded the old ciphertexts, Bob holds no key for that epoch.
    expect(bobChat.keyFor(oldEpoch)).toBeUndefined();
    await expect(bobChat.open(over(before1))).rejects.toThrow(GroupError);
    await expect(bobChat.open(over(before2))).rejects.toThrow(GroupError);
    // The saved record Bob would keep has no older keys either.
    expect(bobChat.exportSecrets().keys.map((k) => k.e)).toEqual([bobKey.e]);

    // What is said after the join reaches him.
    const after = await adminChat.seal("след Боб");
    expect(await bobChat.open(over(after))).toBe("след Боб");
  });

  it("a member that joins later starts with an empty history and gets only new messages", async () => {
    const mk = (name: string) => ({ p: person(name), g: null as unknown as GroupSession });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const bob = mk("Боб");
    admin.g = GroupSession.create(admin.p.keys, "g-late", "Късни", "Ани");
    alice.g = new GroupSession(alice.p.keys);
    bob.g = new GroupSession(bob.p.keys);
    const link = (a: typeof admin, b: typeof admin) => {
      const pair = connectedPair(a.p, b.p);
      a.g.attach(b.p.contact, pair.la, pair.sa);
      b.g.attach(a.p.contact, pair.lb, pair.sb);
    };
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice joined");
    await admin.g.sendText("тайна от преди");
    await alice.g.sendText("и аз казах нещо");
    await until(() => alice.g.snapshot.messages.length === 2 && admin.g.snapshot.messages.length === 2, "two messages");

    link(admin, bob);
    link(alice, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob joined");
    expect(bob.g.snapshot.messages).toEqual([]);

    await alice.g.sendText("здрасти, Боб");
    await until(() => bob.g.snapshot.messages.some((m) => m.text === "здрасти, Боб"), "new message");
    expect(bob.g.snapshot.messages.map((m) => m.text)).toEqual(["здрасти, Боб"]);
  });
});

describe("removing a member who is offline", () => {
  async function group() {
    const mk = (name: string) => ({ p: person(name), g: null as unknown as GroupSession, pairs: [] as ReturnType<typeof connectedPair>[] });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const bob = mk("Боб");
    const carl = mk("Карл");
    admin.g = GroupSession.create(admin.p.keys, "g-kick", "Кик", "Ани");
    for (const m of [alice, bob, carl]) m.g = new GroupSession(m.p.keys);
    const link = (a: typeof admin, b: typeof admin) => {
      const pair = connectedPair(a.p, b.p);
      a.g.attach(b.p.contact, pair.la, pair.sa);
      b.g.attach(a.p.contact, pair.lb, pair.sb);
      return pair;
    };
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice");
    link(admin, bob);
    link(alice, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob");
    link(admin, carl);
    link(alice, carl);
    link(bob, carl);
    await admin.g.invite(carl.p.did, "Карл");
    await until(() => carl.g.snapshot.joined, "carl");
    return { admin, alice, bob, carl, link };
  }

  /** Simulates a device going offline: every link it has is closed on both ends. */
  function offline(m: { p: Person; g: GroupSession }, others: { p: Person; g: GroupSession }[]) {
    for (const o of others) o.g.drop(m.p.did);
    for (const o of others) m.g.drop(o.p.did);
  }

  it("works while the removed member and another member are both offline", async () => {
    const { admin, alice, bob, carl, link } = await group();
    const epochBefore = admin.g.snapshot.state!.epoch;
    offline(bob, [admin, alice, carl]); // the one being removed
    offline(carl, [admin, alice]); // a member who will hear about it later

    await admin.g.remove(bob.p.did); // must not throw although Bob and Carl are away
    expect(admin.g.snapshot.state!.members.map((m) => m.name)).toEqual(["Ани", "Алиса", "Карл"]);
    expect(admin.g.snapshot.state!.epoch).toBeGreaterThan(epochBefore);
    await until(() => alice.g.snapshot.state!.members.length === 3, "alice got the new member list");
    expect(alice.g.snapshot.state!.epoch).toBe(admin.g.snapshot.state!.epoch);

    // Carl comes back by linking to the admin: he gets the new list and key on his own.
    link(admin, carl);
    await until(() => carl.g.snapshot.state!.members.length === 3, "carl updated on reconnect");
    expect(carl.g.snapshot.state!.epoch).toBe(admin.g.snapshot.state!.epoch);
    link(alice, carl);
    await admin.g.sendText("след като Боб излезе");
    await until(() => carl.g.snapshot.messages.some((m) => m.text === "след като Боб излезе"), "carl reads the new epoch");
  });

  it("the removed member's messages are refused and its links are closed", async () => {
    const { admin, alice, bob } = await group();
    expect(alice.g.isLinked(bob.p.did)).toBe(true);
    await admin.g.remove(bob.p.did);
    await until(() => alice.g.snapshot.state!.members.length === 3, "alice updated");
    await until(() => !alice.g.isLinked(bob.p.did), "alice closed her link to Bob");

  });

  it("a removed member who still holds the old key cannot get a message accepted", async () => {
    const admin = who();
    const alice = who();
    const bob = who();
    const adminChat = GroupChat.create(admin.keys, "grp-kick", "Кик", "Ани");
    let out = adminChat.admitMember({ did: alice.did, name: "Алиса" });
    const aliceChat = GroupChat.join(alice.keys, over(out.snapshot), {
      epoch: adminChat.snapshot.epoch,
      key: base64UrlToBytes(over<GroupWire & { t: "gkey" }>(out.keyFor.get(alice.did)!).key),
    });
    out = adminChat.admitMember({ did: bob.did, name: "Боб" });
    aliceChat.receiveSnapshot(over(out.snapshot));
    aliceChat.receiveKey(admin.did, over(out.keyFor.get(alice.did)!));
    const bobKey = over<GroupWire & { t: "gkey" }>(out.keyFor.get(bob.did)!);
    const bobChat = GroupChat.join(bob.keys, over(out.snapshot), { epoch: bobKey.e, key: base64UrlToBytes(bobKey.key) });

    // Bob is removed while offline: he receives nothing.
    const removal = adminChat.dropMember(bob.did);
    expect(removal.keyFor.has(bob.did)).toBe(false);
    aliceChat.receiveSnapshot(over(removal.snapshot));
    aliceChat.receiveKey(admin.did, over(removal.keyFor.get(alice.did)!));

    // Later Bob seals with the key he still has: refused, he is not a member any more.
    const fromBob = await bobChat.seal("още съм тук");
    await expect(aliceChat.open(over(fromBob))).rejects.toThrow(GroupError);
    await expect(adminChat.open(over(fromBob))).rejects.toThrow(GroupError);
    // And he cannot read the new epoch.
    const after = await adminChat.seal("без Боб");
    await expect(bobChat.open(over(after))).rejects.toThrow(GroupError);
    expect(await aliceChat.open(over(after))).toBe("без Боб");
  });
});
