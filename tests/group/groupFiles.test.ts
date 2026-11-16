import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deriveHistoryKey } from "../../src/history/messageStore";
import { GroupSession } from "../../src/group/groupSession";
import { loadGroupHistory } from "../../src/group/groupStore";
import { CHUNK_BYTES, MAX_GROUP_FILE_BYTES } from "../../src/p2p/fileTransfer";
import { connectedPair, person, quiet, until, type Person } from "./fakeLinks";

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

const keyOf = (p: Person) => deriveHistoryKey({ did: p.did, keyPair: p.keys });
type M = { p: Person; g: GroupSession };

function link(a: M, b: M) {
  const pair = connectedPair(a.p, b.p);
  a.g.attach(b.p.contact, pair.la, pair.sa);
  b.g.attach(a.p.contact, pair.lb, pair.sb);
  return pair;
}

async function trio() {
  const mk = (name: string): M => ({ p: person(name), g: null as unknown as GroupSession });
  const admin = mk("Ани");
  const alice = mk("Алиса");
  const bob = mk("Боб");
  admin.g = GroupSession.create(admin.p.keys, "g-files", "Файлове", "Ани", { historyKey: keyOf(admin.p) });
  alice.g = new GroupSession(alice.p.keys, { historyKey: keyOf(alice.p) });
  bob.g = new GroupSession(bob.p.keys, { historyKey: keyOf(bob.p) });
  link(admin, alice);
  await admin.g.invite(alice.p.did, "Алиса");
  await until(() => alice.g.snapshot.joined, "alice");
  link(admin, bob);
  link(alice, bob);
  await admin.g.invite(bob.p.did, "Боб");
  await until(() => bob.g.snapshot.joined, "bob");
  await until(() => alice.g.snapshot.state?.members.length === 3, "alice sees bob");
  return { admin, alice, bob };
}

function payload(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

describe("files in a group", () => {
  it("a member's file reaches every member who accepts it, byte for byte, and lands in the history", async () => {
    const { admin, alice, bob } = await trio();
    const data = payload(CHUNK_BYTES * 2 + 99);
    const sending = alice.g.sendFile(new Blob([data as BlobPart]), "план.pdf");
    for (const m of [admin, bob]) {
      await until(() => m.g.snapshot.transfers.some((t) => t.phase === "offer"), `${m.p.contact.name} sees the offer`);
      const t = m.g.snapshot.transfers.find((x) => x.phase === "offer")!;
      expect(t.peer).toBe(alice.p.did);
      expect(t.name).toBe("план.pdf");
      await m.g.acceptFile(t.peer, t.id);
    }
    expect(await sending).toEqual({ delivered: 2, offered: 2, paused: 0 });
    for (const m of [admin, bob]) {
      await until(() => m.g.snapshot.messages.some((x) => x.file?.name === "план.pdf"), "file message");
      const msg = m.g.snapshot.messages.find((x) => x.file)!;
      expect(msg.from).toBe(alice.p.did);
      const blob = await m.g.loadFile(msg.file!.id);
      expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(data);
    }
    expect(alice.g.snapshot.messages.some((x) => x.mine && x.file?.name === "план.pdf")).toBe(true);
    await bob.g.flush();
    const saved = await loadGroupHistory(keyOf(bob.p), "g-files");
    expect(saved.some((h) => h.text.includes("план.pdf"))).toBe(true);
  });

  it("a member who declines gets nothing, the others still do", async () => {
    const { admin, alice, bob } = await trio();
    const sending = admin.g.sendFile(new Blob([payload(500) as BlobPart]), "x.bin");
    await until(() => alice.g.snapshot.transfers.length === 1 && bob.g.snapshot.transfers.length === 1, "offers");
    const ta = alice.g.snapshot.transfers[0];
    const tb = bob.g.snapshot.transfers[0];
    await alice.g.acceptFile(ta.peer, ta.id);
    await bob.g.cancelFile(tb.peer, tb.id);
    expect(await sending).toEqual({ delivered: 1, offered: 2, paused: 0 });
    await quiet();
    expect(bob.g.snapshot.messages.some((m) => m.file)).toBe(false);
    expect(alice.g.snapshot.messages.some((m) => m.file)).toBe(true);
  });

  it("refuses a file over 50 MB before anything is offered", async () => {
    const { alice, bob } = await trio();
    const big = { size: MAX_GROUP_FILE_BYTES + 1 } as Blob;
    await expect(alice.g.sendFile(big, "big.bin")).rejects.toThrow("твърде голям");
    await quiet();
    expect(bob.g.snapshot.transfers).toEqual([]);
  });

  it("a member who joins later is not offered a file sent before it joined", async () => {
    const mk = (name: string): M => ({ p: person(name), g: null as unknown as GroupSession });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const carl = mk("Карл");
    admin.g = GroupSession.create(admin.p.keys, "g-late-file", "Късни", "Ани");
    alice.g = new GroupSession(alice.p.keys);
    carl.g = new GroupSession(carl.p.keys);
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice");
    // Carl is linked to the admin but is not a member yet.
    link(admin, carl);
    const sending = admin.g.sendFile(new Blob([payload(300) as BlobPart]), "преди.bin");
    await until(() => alice.g.snapshot.transfers.length === 1, "alice offered");
    expect(carl.g.snapshot.transfers).toEqual([]);
    await alice.g.acceptFile(alice.g.snapshot.transfers[0].peer, alice.g.snapshot.transfers[0].id);
    expect(await sending).toEqual({ delivered: 1, offered: 1, paused: 0 });

    link(alice, carl);
    await admin.g.invite(carl.p.did, "Карл");
    await until(() => carl.g.snapshot.joined, "carl joined");
    await quiet(200);
    expect(carl.g.snapshot.messages).toEqual([]);
    expect(carl.g.snapshot.transfers).toEqual([]);
  });

  it("a text that looks like a file card stays text", async () => {
    const { alice, bob } = await trio();
    await alice.g.sendText('\u0001C|{"id":"AAAAAAAAAAA","name":"fake.exe","size":1,"mime":"x","stored":true}');
    await until(() => bob.g.snapshot.messages.length === 1, "message");
    expect(bob.g.snapshot.messages[0].file).toBeUndefined();
    expect(bob.g.snapshot.messages[0].text).toContain("fake.exe");
  });
});
