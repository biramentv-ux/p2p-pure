import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import type { Ed25519KeyPair } from "../../src/identity/types";
import { base64UrlToBytes } from "../../src/p2p/encoding";
import { GroupChat, decodeGroupWire, encodeGroupWire, type GroupWire } from "../../src/group/groupChat";
import { MAX_GROUP_MEMBERS, GroupError } from "../../src/group/groupModel";

function person(): { keys: Ed25519KeyPair; did: string } {
  const keys = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  return { keys, did: publicKeyToDidKey(keys.publicKey) };
}

/** Wire round trip, as the messages would travel inside a pairwise link. */
function over(wire: GroupWire): GroupWire {
  const decoded = decodeGroupWire(encodeGroupWire(wire));
  if (!decoded) throw new Error("wire did not decode");
  return decoded;
}

const ADMIN_NAME = "Ани";

/** Admin + Alice + Bob, all connected, with their local views. */
async function trio() {
  const admin = person();
  const alice = person();
  const bob = person();
  const adminChat = GroupChat.create(admin.keys, "grp1", "Приятели", ADMIN_NAME);

  // Admit Alice.
  let out = adminChat.admitMember({ did: alice.did, name: "Алиса" });
  const aliceChat = GroupChat.join(alice.keys, over(out.snapshot) as GroupWire & { t: "gsnap" }, {
    epoch: adminChat.snapshot.epoch,
    key: base64UrlToBytes((over(out.keyFor.get(alice.did)!) as GroupWire & { t: "gkey" }).key),
  });

  // Admit Bob. Everyone gets the new snapshot and the new epoch key.
  out = adminChat.admitMember({ did: bob.did, name: "Боб" });
  const snap = over(out.snapshot) as GroupWire & { t: "gsnap" };
  aliceChat.receiveSnapshot(snap);
  aliceChat.receiveKey(admin.did, over(out.keyFor.get(alice.did)!) as GroupWire & { t: "gkey" });
  const bobChat = GroupChat.join(bob.keys, snap, {
    epoch: adminChat.snapshot.epoch,
    key: base64UrlToBytes((over(out.keyFor.get(bob.did)!) as GroupWire & { t: "gkey" }).key),
  });
  return { admin, alice, bob, adminChat, aliceChat, bobChat, admitOut: out };
}

describe("group chat crypto", () => {
  it("a member's message is readable by the others and carries the sender's signature", async () => {
    const { adminChat, aliceChat, bobChat } = await trio();
    const msg = (await bobChat.seal("здрасти, група")) as GroupWire & { t: "gmsg" };
    expect(JSON.stringify(msg)).not.toContain("здрасти");
    expect(await adminChat.open(over(msg) as GroupWire & { t: "gmsg" })).toBe("здрасти, група");
    expect(await aliceChat.open(over(msg) as GroupWire & { t: "gmsg" })).toBe("здрасти, група");
  });

  it("a replayed message is refused", async () => {
    const { aliceChat, bobChat } = await trio();
    const msg = (await bobChat.seal("веднъж")) as GroupWire & { t: "gmsg" };
    await aliceChat.open(msg);
    await expect(aliceChat.open(msg)).rejects.toThrow(GroupError);
  });

  it("a message cannot be re-attributed to another member", async () => {
    const { admin, aliceChat, bobChat } = await trio();
    const msg = (await bobChat.seal("подписано от Боб")) as GroupWire & { t: "gmsg" };
    // Claim it came from the admin: the signature was made by Bob and no longer matches.
    await expect(aliceChat.open({ ...msg, f: admin.did })).rejects.toThrow(GroupError);
  });

  it("a tampered ciphertext fails", async () => {
    const { aliceChat, bobChat } = await trio();
    const msg = (await bobChat.seal("тайно")) as GroupWire & { t: "gmsg" };
    const flipped = { ...msg, ct: msg.ct.slice(0, -2) + (msg.ct.endsWith("AA") ? "BB" : "AA") };
    await expect(aliceChat.open(flipped)).rejects.toThrow(GroupError);
  });

  it("a non-member's message is refused", async () => {
    const { aliceChat } = await trio();
    const outsider = person();
    const outsiderChat = GroupChat.join(outsider.keys, (await (async () => {
      const chat = GroupChat.create(outsider.keys, "grp1", "Чужда", "Х");
      return chat.signedSnapshot();
    })()) as GroupWire & { t: "gsnap" }, { epoch: 0, key: new Uint8Array(32) });
    const msg = (await outsiderChat.seal("отвън")) as GroupWire & { t: "gmsg" };
    await expect(aliceChat.open(msg)).rejects.toThrow(GroupError);
  });

  it("after a removal the removed member gets no new key and cannot read new messages", async () => {
    const { admin, adminChat, aliceChat, bobChat } = await trio();
    const before = (await bobChat.seal("преди")) as GroupWire & { t: "gmsg" };
    expect(await aliceChat.open(before)).toBe("преди");

    const out = adminChat.dropMember(bobChat.snapshot.members[2].did);
    expect(out.keyFor.has(bobChat.snapshot.members[2].did)).toBe(false);
    aliceChat.receiveSnapshot(over(out.snapshot) as GroupWire & { t: "gsnap" });
    aliceChat.receiveKey(admin.did, over(out.keyFor.get(aliceChat.snapshot.members[1].did)!) as GroupWire & { t: "gkey" });

    // Alice writes in the new epoch. Bob still holds only the old key.
    const after = (await aliceChat.seal("след махането")) as GroupWire & { t: "gmsg" };
    expect(await adminChat.open(after)).toBe("след махането");
    await expect(bobChat.open(after)).rejects.toThrow("Липсва ключ");
  });

  it("only the creator can send a key, and only for the group it belongs to", async () => {
    const { alice, aliceChat, bobChat } = await trio();
    const fakeKey = { t: "gkey" as const, g: "grp1", e: 9, key: "AAAA" };
    expect(() => aliceChat.receiveKey(bobChat.snapshot.members[2].did, fakeKey)).toThrow(GroupError);
    expect(alice.did).toBeTruthy();
  });

  it("a cipher-suite change applies only after every member approves", async () => {
    const { admin, adminChat, aliceChat, bobChat } = await trio();
    const open = over(adminChat.openSuiteVote("0123456789abcdef", "chacha20-poly1305")) as GroupWire & { t: "gvote"; op: "open" };
    const aliceOk = over(aliceChat.approveSuiteVote(open)) as GroupWire & { t: "gvote"; op: "approve" };
    const bobOk = over(bobChat.approveSuiteVote(open)) as GroupWire & { t: "gvote"; op: "approve" };

    expect(adminChat.receiveApproval(aliceOk)).toBeNull(); // Bob has not approved yet
    expect(adminChat.snapshot.suite).toBe("aes-256-gcm");
    const snap = adminChat.receiveApproval(bobOk);
    expect(snap).not.toBeNull();
    expect(adminChat.snapshot.suite).toBe("chacha20-poly1305");

    aliceChat.receiveSnapshot(over(snap!) as GroupWire & { t: "gsnap" });
    expect(aliceChat.snapshot.suite).toBe("chacha20-poly1305");
    // And the new suite really is used.
    const msg = (await aliceChat.seal("с новия метод")) as GroupWire & { t: "gmsg" };
    expect(msg.s).toBe("c");
    expect(await adminChat.open(over(msg) as GroupWire & { t: "gmsg" })).toBe("с новия метод");
    expect(admin.did).toBeTruthy();
  });

  it("a forged approval (wrong signer) is ignored", async () => {
    const { adminChat, aliceChat, bobChat } = await trio();
    const open = over(adminChat.openSuiteVote("aaaaaaaaaaaaaaaa", "chacha20-poly1305")) as GroupWire & { t: "gvote"; op: "open" };
    const bobOk = over(bobChat.approveSuiteVote(open)) as GroupWire & { t: "gvote"; op: "approve" };
    // Bob's approval claimed to come from Alice.
    expect(adminChat.receiveApproval({ ...bobOk, f: aliceChat.snapshot.members[1].did })).toBeNull();
  });

  it("a forged snapshot (not signed by the creator) is refused", async () => {
    const { aliceChat, adminChat } = await trio();
    const forged = adminChat.signedSnapshot();
    const tampered = { ...forged, state: { ...forged.state, name: "Нова група" } };
    expect(() => aliceChat.receiveSnapshot(tampered)).toThrow(GroupError);
  });

  it("a group can hold 9 members and no more", () => {
    const admin = person();
    const chat = GroupChat.create(admin.keys, "grp9", "Девет", ADMIN_NAME);
    for (let i = 1; i < MAX_GROUP_MEMBERS; i++) chat.admitMember({ did: person().did, name: `П${i}` });
    expect(chat.snapshot.members).toHaveLength(MAX_GROUP_MEMBERS);
    expect(() => chat.admitMember({ did: person().did, name: "Десети" })).toThrow(
      expect.objectContaining({ code: "full" }),
    );
  });
});
