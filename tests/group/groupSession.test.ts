import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import type { Ed25519KeyPair } from "../../src/identity/types";
import type { Contact } from "../../src/contacts/contacts";
import { createEphemeralKeyPair, SecureSession } from "../../src/p2p/secureSession";
import { GroupSession } from "../../src/group/groupSession";

function person(name: string) {
  const keys: Ed25519KeyPair = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  const did = publicKeyToDidKey(keys.publicKey);
  const contact: Contact = { did, publicKey: keys.publicKey, name, verified: true, addedAt: 0 };
  return { keys, did, contact };
}

/** A stand-in for PeerLink: send() queues text for the other end, which delivers it to its handlers. */
class FakeLink {
  peer!: FakeLink;
  open = true;
  private handlers = new Set<(text: string) => void>();
  readonly inbox: string[] = [];

  send(text: string): void {
    if (!this.open) throw new Error("Data channel is not open.");
    this.peer.inbox.push(text);
  }
  onMessage(handler: (text: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(text: string): void {
    for (const h of [...this.handlers]) h(text);
  }
  close(): void {
    this.open = false;
  }
}

/** Both ends of one encrypted pairwise link: a real session pair and two FakeLinks. */
function linkPair(a: ReturnType<typeof person>, b: ReturnType<typeof person>) {
  const ephA = createEphemeralKeyPair();
  const ephB = createEphemeralKeyPair();
  const sa = SecureSession.derive({
    role: "initiator", myIdentity: a.keys, myEphemeral: ephA,
    peerIdentityPublicKey: b.keys.publicKey, peerEphemeralPublicKey: ephB.publicKey,
  });
  const sb = SecureSession.derive({
    role: "responder", myIdentity: b.keys, myEphemeral: ephB,
    peerIdentityPublicKey: a.keys.publicKey, peerEphemeralPublicKey: ephA.publicKey,
  });
  const la = new FakeLink();
  const lb = new FakeLink();
  la.peer = lb;
  lb.peer = la;
  return { la, lb, sa, sb };
}

/**
 * Delivers queued text in both directions until nothing moves for several quiet rounds.
 * Encryption is asynchronous, so one empty round is not proof that the queue is done.
 */
async function settle(links: FakeLink[]): Promise<void> {
  let quiet = 0;
  for (let round = 0; round < 2000 && quiet < 5; round++) {
    let moved = false;
    for (const l of links) {
      while (l.inbox.length) {
        moved = true;
        l.emit(l.inbox.shift()!);
      }
    }
    await new Promise((r) => setTimeout(r, 5));
    quiet = moved ? 0 : quiet + 1;
  }
}

describe("GroupSession over real pairwise sessions", () => {
  it("an invited member joins and a message from the admin reaches it, encrypted on the link", async () => {
    const admin = person("Ани");
    const bob = person("Боб");
    const adminGroup = GroupSession.create(admin.keys, "g-live", "Приятели", "Ани");
    const bobGroup = new GroupSession(bob.keys);

    const { la, lb, sa, sb } = linkPair(admin, bob);
    adminGroup.attach(bob.contact, la as never, sa);
    bobGroup.attach(admin.contact, lb as never, sb);
    await adminGroup.invite(bob.did, "Боб");
    await settle([la, lb]);

    expect(bobGroup.snapshot.joined).toBe(true);
    expect(bobGroup.snapshot.state?.members.map((m) => m.did)).toEqual([admin.did, bob.did]);

    // Everything on the wire is ciphertext: the group text must not show up in the link traffic.
    const sent: string[] = [];
    const original = lb.emit.bind(lb);
    lb.emit = (text: string) => {
      sent.push(text);
      original(text);
    };
    await adminGroup.sendText("здрасти, група");
    await settle([la, lb]);

    expect(bobGroup.snapshot.messages.map((m) => m.text)).toEqual(["здрасти, група"]);
    expect(sent.join("")).not.toContain("здрасти");
    expect(adminGroup.snapshot.messages[0].mine).toBe(true);
  });

  it("tells listeners about messages from other members, with the group and sender names, never about its own", async () => {
    const admin = person("Ани");
    const bob = person("Боб");
    const adminGroup = GroupSession.create(admin.keys, "g-notify", "Приятели", "Ани");
    const bobGroup = new GroupSession(bob.keys);
    const { la, lb, sa, sb } = linkPair(admin, bob);
    adminGroup.attach(bob.contact, la as never, sa);
    bobGroup.attach(admin.contact, lb as never, sb);
    await adminGroup.invite(bob.did, "Боб");
    await settle([la, lb]);

    const atBob: { groupName: string; fromName: string; text: string }[] = [];
    const atAdmin: unknown[] = [];
    const off = bobGroup.onIncoming((m) => atBob.push({ groupName: m.groupName, fromName: m.fromName, text: m.text }));
    adminGroup.onIncoming((m) => atAdmin.push(m));
    await adminGroup.sendText("има ли някой?");
    await settle([la, lb]);

    expect(atBob).toEqual([{ groupName: "Приятели", fromName: "Ани", text: "има ли някой?" }]);
    expect(atAdmin).toEqual([]); // the admin's own message makes no sound on the admin's device
    off();
    await adminGroup.sendText("втори път");
    await settle([la, lb]);
    expect(atBob).toHaveLength(1);
  });

  it("Bob has no messages before any are sent, even with the link up", async () => {
    const admin = person("Ани");
    const bob = person("Боб");
    const group = GroupSession.create(admin.keys, "g-live2", "Група", "Ани");
    const { la, lb, sa, sb } = linkPair(admin, bob);
    group.attach(bob.contact, la as never, sa);
    const bobGroup = new GroupSession(bob.keys);
    bobGroup.attach(admin.contact, lb as never, sb);
    await group.invite(bob.did, "Боб");
    await settle([la, lb]);
    // The admin's view is the only one that should exist; Bob has no chat of his own.
    expect(bobGroup.snapshot.messages).toHaveLength(0);
  });

  it("a removed member loses its link and sees that it was removed", async () => {
    const admin = person("Ани");
    const bob = person("Боб");
    const adminGroup = GroupSession.create(admin.keys, "g-live3", "Група", "Ани");
    const bobGroup = new GroupSession(bob.keys);
    const { la, lb, sa, sb } = linkPair(admin, bob);
    adminGroup.attach(bob.contact, la as never, sa);
    bobGroup.attach(admin.contact, lb as never, sb);
    await adminGroup.invite(bob.did, "Боб");
    await settle([la, lb]);
    expect(bobGroup.snapshot.joined).toBe(true);

    await adminGroup.remove(bob.did);
    await settle([la, lb]);
    expect(adminGroup.isLinked(bob.did)).toBe(false);
    expect(bobGroup.snapshot.removed).toBe(true);
  });

  it("a member's link can be replaced by a fresh one without losing the group", async () => {
    const admin = person("Ани");
    const bob = person("Боб");
    const group = GroupSession.create(admin.keys, "g-live4", "Група", "Ани");
    const first = linkPair(admin, bob);
    group.attach(bob.contact, first.la as never, first.sa);
    const second = linkPair(admin, bob);
    group.attach(bob.contact, second.la as never, second.sa);
    expect(first.la.open).toBe(false);
    expect(group.isLinked(bob.did)).toBe(true);
    expect(group.contactOf(bob.did)?.name).toBe("Боб");
  });
});
