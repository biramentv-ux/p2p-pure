import { describe, it, expect, beforeEach } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import type { Ed25519KeyPair } from "../../src/identity/types";
import { GroupChat, encodeGroupWire, signJoinRequest } from "../../src/group/groupChat";
import { GroupMesh, type MeshEvents } from "../../src/group/groupMesh";
import type { CipherSuite } from "../../src/p2p/cipherSuite";

interface Log {
  messages: string[];
  errors: string[];
  joined: number;
  removed: number;
  pending: number;
  requests: CipherSuite[];
  suites: CipherSuite[];
}

/** One device: its keys, its mesh, and what its user was told. */
class Device {
  readonly keys: Ed25519KeyPair;
  readonly did: string;
  readonly log: Log = { messages: [], errors: [], joined: 0, removed: 0, pending: 0, requests: [], suites: [] };
  mesh!: GroupMesh;

  constructor() {
    this.keys = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    this.did = publicKeyToDidKey(this.keys.publicKey);
  }

  init(chat: GroupChat | null = null): void {
    const log = this.log;
    const events: MeshEvents = {
      message: (from, text) => log.messages.push(`${from}|${text}`),
      membership: () => undefined,
      suite: (s) => log.suites.push(s),
      suiteRequested: (s) => log.requests.push(s),
      pending: () => log.pending++,
      joined: () => log.joined++,
      removed: () => log.removed++,
      error: (m) => log.errors.push(m),
    };
    this.mesh = new GroupMesh(this.keys, events, chat);
  }
}

/** In-memory network: links are two-way, and every delivery waits in one ordered queue. */
class Net {
  private queue: Array<() => Promise<void>> = [];

  link(a: Device, b: Device): void {
    a.mesh.attach(b.did, (text) => {
      this.queue.push(() => b.mesh.handle(a.did, text));
    });
    b.mesh.attach(a.did, (text) => {
      this.queue.push(() => a.mesh.handle(b.did, text));
    });
  }

  deliver(to: Device, from: Device, text: string): void {
    this.queue.push(() => to.mesh.handle(from.did, text));
  }

  async flush(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      await job();
    }
  }
}

let net: Net;
let admin: Device;
let alice: Device;
let bob: Device;

beforeEach(() => {
  net = new Net();
  admin = new Device();
  alice = new Device();
  bob = new Device();
  admin.init(GroupChat.create(admin.keys, "grp-mesh", "Приятели", "Ани"));
  alice.init();
  bob.init();
});

/** Admin, Alice and Bob in the group, every pair linked. */
async function threeInGroup(): Promise<void> {
  net.link(admin, alice);
  await admin.mesh.invite(alice.did, "Алиса");
  await net.flush();
  net.link(admin, bob);
  net.link(alice, bob);
  await admin.mesh.invite(bob.did, "Боб");
  await net.flush();
}

describe("group mesh: joining", () => {
  it("a candidate is admitted once linked to the admin", async () => {
    net.link(admin, alice);
    await admin.mesh.invite(alice.did, "Алиса");
    await net.flush();
    expect(alice.log.pending).toBe(1);
    expect(alice.log.joined).toBe(1);
    expect(alice.mesh.state?.members.map((m) => m.did)).toEqual([admin.did, alice.did]);
    expect(admin.mesh.state?.members).toHaveLength(2);
  });

  it("a candidate waits until it is linked to every member, then is admitted", async () => {
    net.link(admin, alice);
    await admin.mesh.invite(alice.did, "Алиса");
    await net.flush();
    net.link(admin, bob);
    await admin.mesh.invite(bob.did, "Боб");
    await net.flush();
    expect(bob.log.joined).toBe(0);
    expect(bob.mesh.missingLinks()).toEqual([alice.did]);

    net.link(alice, bob);
    await net.flush();
    expect(bob.log.joined).toBe(1);
    expect(admin.mesh.state?.members).toHaveLength(3);
  });

  it("the admin refuses a join request that does not list every member", async () => {
    net.link(admin, alice);
    await admin.mesh.invite(alice.did, "Алиса");
    await net.flush();
    net.link(admin, bob);
    await admin.mesh.invite(bob.did, "Боб");
    await net.flush();
    const forged = signJoinRequest(bob.keys, "grp-mesh", [admin.did]);
    await admin.mesh.handle(bob.did, encodeGroupWire(forged));
    await net.flush();
    expect(admin.log.errors.length).toBeGreaterThan(0);
    expect(admin.mesh.state?.members.map((m) => m.did)).not.toContain(bob.did);
  });

  it("only an invited candidate is admitted", async () => {
    net.link(admin, bob);
    const request = signJoinRequest(bob.keys, "grp-mesh", [admin.did]);
    await admin.mesh.handle(bob.did, encodeGroupWire(request));
    await net.flush();
    expect(admin.mesh.state?.members).toHaveLength(1);
  });

  it("inviting someone who is not linked is refused", async () => {
    await expect(admin.mesh.invite(bob.did, "Боб")).rejects.toThrow("Първо свържете");
  });
});

describe("group mesh: messages", () => {
  it("a message reaches every other member", async () => {
    await threeInGroup();
    await admin.mesh.sendMessage("здрасти, всички");
    await net.flush();
    expect(alice.log.messages).toEqual([`${admin.did}|здрасти, всички`]);
    expect(bob.log.messages).toEqual([`${admin.did}|здрасти, всички`]);
  });

  it("a message whose sender does not match its link is ignored", async () => {
    await threeInGroup();
    const chatAlice = (alice.mesh as unknown as { chat: GroupChat }).chat;
    const wire = await chatAlice.seal("от Алиса");
    // The message arrives on Bob's link, but says it is from Alice.
    await admin.mesh.handle(bob.did, encodeGroupWire(wire));
    expect(admin.log.messages).toHaveLength(0);
  });
});

describe("group mesh: removing a member", () => {
  it("the removed member is told, its link closes, and the rest get a new key", async () => {
    await threeInGroup();
    await admin.mesh.drop(alice.did);
    await net.flush();
    expect(alice.log.removed).toBe(1);
    expect(admin.mesh.linkedDids).not.toContain(alice.did);
    expect(bob.mesh.state?.members.map((m) => m.did)).not.toContain(alice.did);

    await admin.mesh.sendMessage("само за останалите");
    await net.flush();
    expect(bob.log.messages).toContain(`${admin.did}|само за останалите`);
    expect(alice.log.messages).toHaveLength(0);
  });
});

describe("group mesh: cipher suite vote", () => {
  it("a change applies only after every member answers yes", async () => {
    await threeInGroup();
    await admin.mesh.openSuite("chacha20-poly1305");
    await net.flush();
    expect(alice.log.requests).toEqual(["chacha20-poly1305"]);
    expect(bob.log.requests).toEqual(["chacha20-poly1305"]);
    expect(admin.log.suites).toEqual([]);

    await alice.mesh.answerSuite(true);
    await net.flush();
    expect(admin.log.suites).toEqual([]);

    await bob.mesh.answerSuite(true);
    await net.flush();
    expect(admin.log.suites).toEqual(["chacha20-poly1305"]);
    expect(alice.log.suites).toEqual(["chacha20-poly1305"]);
    expect(bob.log.suites).toEqual(["chacha20-poly1305"]);
  });

  it("one refusal stops the change", async () => {
    await threeInGroup();
    await admin.mesh.openSuite("chacha20-poly1305");
    await net.flush();
    await alice.mesh.answerSuite(false);
    await bob.mesh.answerSuite(true);
    await net.flush();
    expect(admin.log.suites).toEqual([]);
    expect(alice.log.suites).toEqual([]);
  });

  it("a member cannot answer a vote that was never opened", async () => {
    await threeInGroup();
    await expect(alice.mesh.answerSuite(true)).rejects.toThrow("Няма предложение");
  });
});

describe("group mesh: only the admin acts as admin", () => {
  it("a member cannot invite, drop or open a vote", async () => {
    await threeInGroup();
    await expect(alice.mesh.invite(bob.did, "Боб")).rejects.toThrow("Само създателят");
    await expect(alice.mesh.drop(bob.did)).rejects.toThrow("Само създателят");
    await expect(alice.mesh.openSuite("chacha20-poly1305")).rejects.toThrow("Само създателят");
  });
});
