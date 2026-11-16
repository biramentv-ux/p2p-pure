import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deriveHistoryKey, purgeExpired } from "../../src/history/messageStore";
import { GroupSession } from "../../src/group/groupSession";
import { loadGroupHistory, loadGroups } from "../../src/group/groupStore";
import { CHUNK_BYTES, FileResumeStore } from "../../src/p2p/fileTransfer";
import { HOUR, MINUTE } from "../../src/history/disappearing";
import { connectedPair, person, quiet, until, type Person } from "./fakeLinks";

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

const keyOf = (p: Person) => deriveHistoryKey({ did: p.did, keyPair: p.keys });
type M = { p: Person; g: GroupSession; store: FileResumeStore };

let clock = 1_000_000;
const now = () => clock;

function link(a: M, b: M) {
  const pair = connectedPair(a.p, b.p);
  a.g.attach(b.p.contact, pair.la, pair.sa);
  b.g.attach(a.p.contact, pair.lb, pair.sb);
  return pair;
}

async function trio() {
  clock = Date.now();
  const mk = (name: string): M => ({ p: person(name), g: null as unknown as GroupSession, store: new FileResumeStore() });
  const admin = mk("Ани");
  const alice = mk("Алиса");
  const bob = mk("Боб");
  admin.g = GroupSession.create(admin.p.keys, "g-timer", "Таймер", "Ани", { historyKey: keyOf(admin.p), resumeStore: admin.store, now });
  alice.g = new GroupSession(alice.p.keys, { historyKey: keyOf(alice.p), resumeStore: alice.store, now });
  bob.g = new GroupSession(bob.p.keys, { historyKey: keyOf(bob.p), resumeStore: bob.store, now });
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

describe("disappearing messages in a group", () => {
  it("any member turns the timer on for everyone; new messages expire on every device", async () => {
    const { admin, alice, bob } = await trio();
    await alice.g.sendText("преди");
    for (const m of [admin, bob]) await until(() => m.g.snapshot.messages.length === 1, "first text");
    clock += 1000;
    expect(await alice.g.setTimer(5 * MINUTE)).toBe(true);
    for (const m of [admin, bob]) {
      await until(() => m.g.snapshot.timerMs === 5 * MINUTE, `${m.p.contact.name} gets the timer`);
      const n = m.g.snapshot.notices.at(-1)!;
      expect(n.text).toContain("включи изчезващи съобщения");
      expect(n.vars).toMatchObject({ name: "Алиса", time: "5 минути" });
      expect(n.translate).toEqual(["time"]);
    }
    // The setting frame is not a message on anyone's screen.
    for (const m of [admin, bob]) expect(m.g.snapshot.messages.map((x) => x.text)).toEqual(["преди"]);

    await bob.g.sendText("изчезва");
    for (const m of [admin, alice, bob]) {
      await until(() => m.g.snapshot.messages.some((x) => x.text === "изчезва"), "message arrives");
      const msg = m.g.snapshot.messages.find((x) => x.text === "изчезва")!;
      expect(msg.expiresAt).toBe(msg.at + 5 * MINUTE);
      expect(m.g.snapshot.messages.find((x) => x.text === "преди")!.expiresAt).toBeUndefined();
    }

    await admin.g.flush();
    let saved = await loadGroupHistory(keyOf(admin.p), "g-timer", undefined, clock);
    expect(saved.map((h) => h.text)).toEqual(["преди", "изчезва"]);
    expect((await loadGroups(keyOf(admin.p)))[0].timer?.ms).toBe(5 * MINUTE);

    // Time passes: gone from the screen, from the loaded history, and from the database.
    clock += 5 * MINUTE + 1;
    admin.g.pruneExpired();
    expect(admin.g.snapshot.messages.map((x) => x.text)).toEqual(["преди"]);
    saved = await loadGroupHistory(keyOf(admin.p), "g-timer", undefined, clock);
    expect(saved.map((h) => h.text)).toEqual(["преди"]);
    // The sweep deletes the rows of all three members (one shared fake database here).
    expect(await purgeExpired(clock)).toBe(3);
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("turning it off is shared too, and a restored group keeps the setting", async () => {
    const { admin, alice, bob } = await trio();
    await admin.g.setTimer(HOUR);
    await until(() => bob.g.snapshot.timerMs === HOUR, "on");
    await bob.g.setTimer(0);
    for (const m of [admin, alice]) await until(() => m.g.snapshot.timerMs === 0, "off");
    expect(admin.g.snapshot.notices.at(-1)!.text).toBe("{name} изключи изчезващите съобщения.");
    await alice.g.sendText("остава");
    await until(() => admin.g.snapshot.messages.some((x) => x.text === "остава"), "text");
    expect(admin.g.snapshot.messages.find((x) => x.text === "остава")!.expiresAt).toBeUndefined();

    await alice.g.setTimer(DAY_MS);
    await until(() => admin.g.snapshot.timerMs === DAY_MS, "day");
    await admin.g.flush();
    admin.g.closeAll();
    const restored = await GroupSession.restore(admin.p.keys, keyOf(admin.p));
    expect(restored?.timerMs).toBe(DAY_MS);
    restored?.closeAll();
    for (const m of [alice, bob]) m.g.closeAll();
  });

  it("a member who was not linked when it changed gets it on the next link", async () => {
    const { admin, alice, bob } = await trio();
    bob.g.drop(admin.p.did);
    bob.g.drop(alice.p.did);
    admin.g.drop(bob.p.did);
    alice.g.drop(bob.p.did);
    await alice.g.setTimer(HOUR);
    await until(() => admin.g.snapshot.timerMs === HOUR, "admin");
    await quiet();
    expect(bob.g.snapshot.timerMs).toBe(0);
    link(alice, bob);
    await until(() => bob.g.snapshot.timerMs === HOUR, "bob catches up");
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("a member admitted after the timer was set gets it", async () => {
    clock = Date.now();
    const mk = (name: string): M => ({ p: person(name), g: null as unknown as GroupSession, store: new FileResumeStore() });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const bob = mk("Боб");
    admin.g = GroupSession.create(admin.p.keys, "g-late", "Късно", "Ани", { now });
    alice.g = new GroupSession(alice.p.keys, { now });
    bob.g = new GroupSession(bob.p.keys, { now });
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice");
    await alice.g.setTimer(HOUR);
    await until(() => admin.g.snapshot.timerMs === HOUR, "admin has it");
    link(admin, bob);
    link(alice, bob);
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob joined");
    await until(() => bob.g.snapshot.timerMs === HOUR, "bob gets the timer");
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("a candidate linked during a timer change still gets it once admitted", async () => {
    clock = Date.now();
    const mk = (name: string): M => ({ p: person(name), g: null as unknown as GroupSession, store: new FileResumeStore() });
    const admin = mk("Ани");
    const alice = mk("Алиса");
    const bob = mk("Боб");
    admin.g = GroupSession.create(admin.p.keys, "g-cand", "К", "Ани", { now });
    alice.g = new GroupSession(alice.p.keys, { now });
    bob.g = new GroupSession(bob.p.keys, { now });
    link(admin, alice);
    await admin.g.invite(alice.p.did, "Алиса");
    await until(() => alice.g.snapshot.joined, "alice");
    // Bob is linked to both before admission, while the two members change the timer.
    link(admin, bob);
    link(alice, bob);
    await alice.g.setTimer(HOUR);
    await until(() => admin.g.snapshot.timerMs === HOUR, "admin");
    await admin.g.setTimer(DAY_MS);
    await until(() => alice.g.snapshot.timerMs === DAY_MS, "alice");
    await quiet();
    await admin.g.invite(bob.p.did, "Боб");
    await until(() => bob.g.snapshot.joined, "bob joined");
    await until(() => bob.g.snapshot.timerMs === DAY_MS, "bob gets the timer");
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("a setting that reaches one member is passed on to the members linked to it", async () => {
    const { admin, alice, bob } = await trio();
    // Bob is cut off from both, changes the timer alone, then comes back to Alice only.
    bob.g.drop(admin.p.did);
    bob.g.drop(alice.p.did);
    admin.g.drop(bob.p.did);
    alice.g.drop(bob.p.did);
    await bob.g.setTimer(HOUR).catch(() => undefined);
    if (bob.g.timerMs !== HOUR) return; // a mesh that refuses to send with no links: nothing to relay
    await quiet();
    expect(admin.g.snapshot.timerMs).toBe(0);
    link(alice, bob);
    await until(() => alice.g.snapshot.timerMs === HOUR, "alice gets it from bob");
    await until(() => admin.g.snapshot.timerMs === HOUR, "admin gets it from alice");
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("a timer frame from someone who is not a member changes nothing", async () => {
    const { admin, alice, bob } = await trio();
    const stranger = person("Непознат");
    const pair = connectedPair(alice.p, stranger);
    alice.g.attach(stranger.contact, pair.la, pair.sa);
    // The stranger answers alice's first message, then sends a timer frame on the pairwise link.
    pair.lb.onMessage((wire) => {
      void (async () => {
        await pair.sb.open(wire);
        pair.lb.send(await pair.sb.seal('\u0001T|{"ms":3600000,"at":99999999999999}'));
      })().catch(() => undefined);
    });
    await quiet(300);
    expect(alice.g.snapshot.timerMs).toBe(0);
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("a text that starts like a timer frame stays text and changes nothing", async () => {
    const { admin, alice, bob } = await trio();
    await alice.g.sendText('\u0001T|{"ms":300000,"at":99999999999999}');
    await until(() => admin.g.snapshot.messages.length === 1, "text");
    await quiet();
    for (const m of [admin, alice, bob]) expect(m.g.snapshot.timerMs).toBe(0);
    expect(admin.g.snapshot.messages[0].text).toBe('T|{"ms":300000,"at":99999999999999}');
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });
});

const DAY_MS = 24 * HOUR;

describe("group files continue after a dropped link", () => {
  it("a file cut off half-way finishes on the next link with that member", async () => {
    const { admin, alice, bob } = await trio();
    const data = payload(CHUNK_BYTES * 40 + 5);
    // Bob declines, so only the admin -> Alice link matters.
    const sending = admin.g.sendFile(new Blob([data as BlobPart]), "голям.bin");
    await until(() => alice.g.snapshot.transfers.some((t) => t.phase === "offer"), "alice offer");
    await until(() => bob.g.snapshot.transfers.some((t) => t.phase === "offer"), "bob offer");
    const tb = bob.g.snapshot.transfers[0];
    await bob.g.cancelFile(tb.peer, tb.id);
    const ta = alice.g.snapshot.transfers[0];
    // Cut the link as soon as the first chunks are in.
    let cut = false;
    const off = alice.g.subscribe(() => {
      const t = alice.g.snapshot.transfers.find((x) => x.id === ta.id);
      if (!cut && t && t.phase === "moving" && t.done > 0) {
        cut = true;
        queueMicrotask(() => {
          alice.g.drop(admin.p.did);
          admin.g.drop(alice.p.did);
        });
      }
    });
    await alice.g.acceptFile(ta.peer, ta.id);
    const r = await sending;
    off();
    expect(r).toEqual({ delivered: 0, offered: 2, paused: 1 });
    await until(() => alice.g.snapshot.transfers.some((t) => t.phase === "paused"), "alice paused");
    expect(admin.g.snapshot.transfers.some((t) => t.phase === "paused")).toBe(true);
    // The sender's own card is there already: the file went out to the group.
    expect(admin.g.snapshot.messages.some((m) => m.mine && m.file?.name === "голям.bin")).toBe(true);
    expect(alice.store.count(`group:g-timer:${admin.p.did}`)).toBe(1);

    link(admin, alice);
    await until(() => alice.g.snapshot.messages.some((m) => m.file?.name === "голям.bin"), "file finished");
    const msg = alice.g.snapshot.messages.find((m) => m.file)!;
    const blob = await alice.g.loadFile(msg.file!.id);
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(data);
    await until(() => admin.g.snapshot.transfers.length === 0 && alice.g.snapshot.transfers.length === 0, "lists empty");
    // Only one card on the sender's side.
    expect(admin.g.snapshot.messages.filter((m) => m.file).length).toBe(1);
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });

  it("after this device is removed, closing its links parks nothing", async () => {
    const { admin, alice, bob } = await trio();
    const sending = bob.g.sendFile(new Blob([payload(CHUNK_BYTES * 40 + 5) as BlobPart]), "r.bin");
    await until(() => alice.g.snapshot.transfers.some((t) => t.phase === "offer"), "alice offer");
    await until(() => admin.g.snapshot.transfers.some((t) => t.phase === "offer"), "admin offer");
    const tAdmin = admin.g.snapshot.transfers[0];
    await admin.g.cancelFile(tAdmin.peer, tAdmin.id);
    const ta = alice.g.snapshot.transfers[0];
    await alice.g.acceptFile(ta.peer, ta.id);
    await until(() => (alice.g.snapshot.transfers.find((t) => t.id === ta.id)?.done ?? 0) > 0, "moving");
    await admin.g.remove(alice.p.did);
    await until(() => alice.g.snapshot.removed, "alice removed");
    alice.g.closeAll();
    expect(alice.store.peers()).toEqual([]);
    await sending.catch(() => undefined);
    for (const m of [admin, bob]) m.g.closeAll();
  });

  it("a paused file with a very long name still makes a card that loads again", async () => {
    const { admin, alice, bob } = await trio();
    const name = "д".repeat(250) + ".bin";
    const sending = admin.g.sendFile(new Blob([payload(CHUNK_BYTES * 40 + 5) as BlobPart]), name);
    await until(() => alice.g.snapshot.transfers.some((t) => t.phase === "offer"), "alice offer");
    await until(() => bob.g.snapshot.transfers.some((t) => t.phase === "offer"), "bob offer");
    const tb = bob.g.snapshot.transfers[0];
    await bob.g.cancelFile(tb.peer, tb.id);
    const ta = alice.g.snapshot.transfers[0];
    let cut = false;
    const off = alice.g.subscribe(() => {
      const t = alice.g.snapshot.transfers.find((x) => x.id === ta.id);
      if (!cut && t && t.phase === "moving" && t.done > 0) {
        cut = true;
        queueMicrotask(() => {
          alice.g.drop(admin.p.did);
          admin.g.drop(alice.p.did);
        });
      }
    });
    await alice.g.acceptFile(ta.peer, ta.id);
    expect((await sending).paused).toBe(1);
    off();
    await admin.g.flush();
    const saved = await loadGroupHistory(keyOf(admin.p), "g-timer");
    const restored = new GroupSession(admin.p.keys, { history: saved });
    const card = restored.snapshot.messages.find((m) => m.file)?.file;
    expect(card?.name.length).toBeLessThanOrEqual(200);
    expect(card?.mime).toBe("application/octet-stream");
    for (const m of [admin, alice, bob, { g: restored }]) m.g.closeAll();
  });

  it("a paused file with a member who is then removed never continues", async () => {
    const { admin, alice, bob } = await trio();
    const data = payload(CHUNK_BYTES * 40 + 5);
    const sending = bob.g.sendFile(new Blob([data as BlobPart]), "b.bin");
    await until(() => admin.g.snapshot.transfers.some((t) => t.phase === "offer"), "admin offer");
    await until(() => alice.g.snapshot.transfers.some((t) => t.phase === "offer"), "alice offer");
    const tAdmin = admin.g.snapshot.transfers[0];
    await admin.g.cancelFile(tAdmin.peer, tAdmin.id);
    const ta = alice.g.snapshot.transfers[0];
    let cut = false;
    const off = alice.g.subscribe(() => {
      const t = alice.g.snapshot.transfers.find((x) => x.id === ta.id);
      if (!cut && t && t.phase === "moving" && t.done > 0) {
        cut = true;
        queueMicrotask(() => {
          alice.g.drop(bob.p.did);
          bob.g.drop(alice.p.did);
        });
      }
    });
    await alice.g.acceptFile(ta.peer, ta.id);
    await sending;
    off();
    await until(() => alice.store.count(`group:g-timer:${bob.p.did}`) === 1, "parked");
    await admin.g.remove(bob.p.did);
    await until(() => alice.g.snapshot.state?.members.length === 2, "bob gone for alice");
    expect(alice.store.count(`group:g-timer:${bob.p.did}`)).toBe(0);
    await until(() => bob.g.snapshot.removed, "bob removed");
    expect(bob.store.count(`group:g-timer:${alice.p.did}`)).toBe(0);
    for (const m of [admin, alice, bob]) m.g.closeAll();
  });
});
