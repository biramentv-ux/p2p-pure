import { beforeEach, describe, expect, it } from "vitest";
import { GroupChat, encodeGroupWire, type GroupWire } from "../../src/group/groupChat";
import { GroupMesh, type MeshEvents } from "../../src/group/groupMesh";
import { person, type Person } from "./fakeLinks";

/** One device with its mesh and a log of what the mesh told it. */
class Device {
  readonly p: Person;
  readonly intros: string[] = [];
  readonly relayed: Array<{ from: string; inv: string }> = [];
  readonly errors: string[] = [];
  readonly photoAsks: Array<{ from: string; hash: string }> = [];
  mesh!: GroupMesh;

  constructor(name: string) {
    this.p = person(name);
  }

  get did(): string {
    return this.p.did;
  }

  init(chat: GroupChat | null = null): void {
    const events: MeshEvents = {
      message: () => undefined,
      membership: () => undefined,
      suite: () => undefined,
      suiteRequested: () => undefined,
      pending: () => undefined,
      joined: () => undefined,
      removed: () => undefined,
      error: (m) => this.errors.push(m),
      introduced: (peer) => this.intros.push(peer),
      relayed: (from, inv) => this.relayed.push({ from, inv }),
      photoRequested: (from, hash) => this.photoAsks.push({ from, hash }),
    };
    this.mesh = new GroupMesh(this.p.keys, events, chat);
  }
}

class Net {
  private queue: Array<() => Promise<void>> = [];
  /** Every plaintext group message, as "from>to wire". */
  readonly traffic: Array<{ from: string; to: string; wire: string }> = [];

  link(a: Device, b: Device): void {
    a.mesh.attach(b.did, (text) => {
      this.traffic.push({ from: a.did, to: b.did, wire: text });
      this.queue.push(() => b.mesh.handle(a.did, text));
    });
    b.mesh.attach(a.did, (text) => {
      this.traffic.push({ from: b.did, to: a.did, wire: text });
      this.queue.push(() => a.mesh.handle(b.did, text));
    });
  }

  async flush(): Promise<void> {
    while (this.queue.length) await this.queue.shift()!();
  }
}

let net: Net;
let admin: Device;
let alice: Device;
let bob: Device;
let outsider: Device;

beforeEach(async () => {
  net = new Net();
  admin = new Device("Ани");
  alice = new Device("Алиса");
  bob = new Device("Боб");
  outsider = new Device("Чужд");
  admin.init(GroupChat.create(admin.p.keys, "grp-relay", "Група", "Ани"));
  alice.init();
  bob.init();
  outsider.init();
  net.link(admin, alice);
  await admin.mesh.invite(alice.did, "Алиса");
  await net.flush();
});

describe("auto-linking: introductions", () => {
  it("inviting a candidate asks every linked member to link with it", async () => {
    net.link(admin, bob);
    await admin.mesh.invite(bob.did, "Боб");
    await net.flush();
    expect(alice.intros).toEqual([bob.did]);
    expect(alice.mesh.isKnownPeer(bob.did)).toBe(true);
    expect(alice.mesh.peerName(bob.did)).toBe("Боб");
  });

  it("an introduction that is not from the admin, or not signed by the admin, is ignored", async () => {
    const chatOfBob = GroupChat.create(bob.p.keys, "grp-relay", "Група", "Боб");
    const forged = chatOfBob.signIntro(outsider.did, "Чужд"); // signed by Bob, not the admin
    await alice.mesh.handle(admin.did, encodeGroupWire(forged));
    // A genuine admin introduction, but arriving on Bob's link.
    const real = (admin.mesh as unknown as { chat: GroupChat }).chat.signIntro(outsider.did, "Чужд");
    await alice.mesh.handle(bob.did, encodeGroupWire(real));
    // Changed name: the signature no longer matches.
    await alice.mesh.handle(admin.did, encodeGroupWire({ ...real, name: "Друг" }));
    expect(alice.intros).toEqual([]);
    expect(alice.mesh.isKnownPeer(outsider.did)).toBe(false);
  });

  it("an expired introduction is not accepted", async () => {
    const chat = (admin.mesh as unknown as { chat: GroupChat }).chat;
    const old = chat.signIntro(outsider.did, "Чужд", Date.now() - 60 * 60 * 1000);
    await alice.mesh.handle(admin.did, encodeGroupWire(old));
    expect(alice.intros).toEqual([]);
  });

  it("a member that links to the admin again is introduced to the other linked members", async () => {
    net.link(admin, bob);
    await admin.mesh.invite(bob.did, "Боб");
    net.link(alice, bob);
    await net.flush();
    expect(admin.mesh.state?.members).toHaveLength(3);
    alice.intros.length = 0;
    // Alice reloads: a fresh link to the admin.
    net.link(admin, alice);
    await net.flush();
    expect(alice.intros).toEqual([bob.did]);
  });
});

describe("auto-linking: the admin relays signed invitations", () => {
  beforeEach(async () => {
    net.link(admin, bob);
    await admin.mesh.invite(bob.did, "Боб");
    await net.flush();
  });

  it("a member's invitation reaches the candidate with `from` set by the admin", async () => {
    await alice.mesh.relay(bob.did, "p2p1:offer-from-alice");
    await net.flush();
    expect(bob.relayed).toEqual([{ from: alice.did, inv: "p2p1:offer-from-alice" }]);
    // And the candidate's answer reaches the member, who knows the candidate from the introduction.
    await bob.mesh.relay(alice.did, "p2p1:answer-from-bob");
    await net.flush();
    expect(alice.relayed).toEqual([{ from: bob.did, inv: "p2p1:answer-from-bob" }]);
  });

  it("the admin does not forward to or from people outside the group", async () => {
    net.link(admin, outsider);
    // The outsider asks the admin to forward something to Alice.
    await admin.mesh.handle(outsider.did, encodeGroupWire({ t: "grelay", g: "grp-relay", to: alice.did, inv: "p2p1:x" }));
    // Alice asks the admin to forward something to the outsider.
    await admin.mesh.handle(alice.did, encodeGroupWire({ t: "grelay", g: "grp-relay", to: outsider.did, inv: "p2p1:y" }));
    await net.flush();
    expect(alice.relayed).toEqual([]);
    expect(outsider.relayed).toEqual([]);
    expect(admin.errors.length).toBe(2);
  });

  it("a member cannot set `from` itself: only the admin does", async () => {
    await admin.mesh.handle(alice.did, encodeGroupWire({ t: "grelay", g: "grp-relay", to: bob.did, from: admin.did, inv: "p2p1:z" }));
    await net.flush();
    expect(bob.relayed).toEqual([]);
  });

  it("a relayed invitation that does not come over the admin's link is ignored", async () => {
    const wire: GroupWire = { t: "grelay", g: "grp-relay", to: bob.did, from: alice.did, inv: "p2p1:direct" };
    await bob.mesh.handle(alice.did, encodeGroupWire(wire));
    expect(bob.relayed).toEqual([]);
  });

  it("a relayed invitation from someone who is neither a member nor introduced is refused", async () => {
    const wire: GroupWire = { t: "grelay", g: "grp-relay", to: alice.did, from: outsider.did, inv: "p2p1:who" };
    await alice.mesh.handle(admin.did, encodeGroupWire(wire));
    expect(alice.relayed).toEqual([]);
    expect(alice.errors).toEqual(["Покана от човек извън групата беше отказана."]);
  });

  it("the admin itself never relays: it links directly", async () => {
    await expect(admin.mesh.relay(alice.did, "p2p1:x")).rejects.toThrow("директно");
  });

  it("a too large invitation is not even decoded", async () => {
    const wire = { t: "grelay", g: "grp-relay", to: bob.did, inv: "p2p1:" + "A".repeat(5_000) };
    await admin.mesh.handle(alice.did, encodeGroupWire(wire as GroupWire));
    await net.flush();
    expect(bob.relayed).toEqual([]);
  });
});

describe("group photo requests", () => {
  it("a member's request reaches the admin; an outsider's does not", async () => {
    const hash = "a".repeat(64);
    await alice.mesh.requestPhoto(admin.did, hash);
    await net.flush();
    expect(admin.photoAsks).toEqual([{ from: alice.did, hash }]);
    net.link(admin, outsider);
    await admin.mesh.handle(outsider.did, encodeGroupWire({ t: "gphoto", g: "grp-relay", h: hash }));
    expect(admin.photoAsks).toHaveLength(1);
  });
});
