import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { appendMessage, deriveHistoryKey, loadHistory, purgeExpired } from "../../src/history/messageStore";
import { loadFile, saveFile } from "../../src/history/fileStore";
import { DAY, DISAPPEAR_OPTIONS, HOUR, MINUTE, disappearLabel, expiryFor, newerTimer, validDisappearMs } from "../../src/history/disappearing";
import { decodeBundle, encodeBundle } from "../../src/transfer/bundle";
import { deriveIdentityKeyPair as kp } from "../../src/identity/keypair";
import { CONTROL_MARK, decodeControl, encodeControl } from "../../src/p2p/control";
import { STORE_MESSAGES, withStore } from "../../src/db/database";
import { getContact, lockContacts, saveContact, unlockContacts } from "../../src/contacts/contacts";

function key(): Uint8Array {
  const keyPair = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  return deriveHistoryKey({ did: publicKeyToDidKey(keyPair.publicKey), keyPair });
}

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

describe("disappearing timer values", () => {
  it("accepts only the offered values", () => {
    for (const ms of DISAPPEAR_OPTIONS) expect(validDisappearMs(ms)).toBe(ms);
    for (const bad of [1, -HOUR, HOUR + 1, "3600000", null, NaN]) expect(validDisappearMs(bad)).toBeNull();
  });

  it("computes the expiry only when the timer is on", () => {
    expect(expiryFor(1000, HOUR)).toBe(1000 + HOUR);
    expect(expiryFor(1000, 0)).toBeUndefined();
    expect(expiryFor(1000, undefined)).toBeUndefined();
    expect(expiryFor(1000, 123)).toBeUndefined();
    expect(disappearLabel(DAY)).toBe("1 ден");
    expect(disappearLabel(0)).toBe("Изключено");
  });

  it("the control message round-trips and rejects other values", () => {
    expect(decodeControl(encodeControl({ t: "timer", ms: HOUR, at: 5 }))).toEqual({ t: "timer", ms: HOUR, at: 5 });
    expect(decodeControl(encodeControl({ t: "timer", ms: 0, at: 0 }))).toEqual({ t: "timer", ms: 0, at: 0 });
    expect(decodeControl(CONTROL_MARK + JSON.stringify({ t: "timer", ms: 1, at: 1 }))).toBeNull();
    expect(decodeControl(CONTROL_MARK + JSON.stringify({ t: "timer", ms: HOUR }))).toBeNull();
    expect(decodeControl(CONTROL_MARK + JSON.stringify({ t: "timer", ms: HOUR, at: -1 }))).toBeNull();
  });

  it("two devices pick the same winner, whatever order the settings arrive in", () => {
    const cases = [
      [{ ms: HOUR, at: 10 }, { ms: DAY, at: 11 }],
      [{ ms: HOUR, at: 10 }, { ms: 5 * MINUTE, at: 10 }],
      [{ ms: 0, at: 10 }, { ms: DAY, at: 10 }],
      [{ ms: 0, at: 0 }, { ms: 0, at: 0 }],
    ];
    for (const [a, b] of cases) expect(newerTimer(a, b)).toEqual(newerTimer(b, a));
    expect(newerTimer({ ms: HOUR, at: 10 }, { ms: DAY, at: 11 })).toEqual({ ms: DAY, at: 11 });
    expect(newerTimer({ ms: HOUR, at: 10 }, { ms: 5 * MINUTE, at: 10 }).ms).toBe(5 * MINUTE);
    expect(newerTimer({ ms: 0, at: 10 }, { ms: DAY, at: 10 }).ms).toBe(DAY);
  });

  it("moving to a new device keeps the timer of every contact", () => {
    const pair = kp(mnemonicToSeed(generateMnemonic12()));
    const did = publicKeyToDidKey(pair.publicKey);
    const seed = new Uint8Array(64).fill(1);
    const out = decodeBundle(
      encodeBundle({ seed, contacts: [{ did, publicKey: pair.publicKey, name: "А", verified: true, addedAt: 1, disappearMs: HOUR, disappearAt: 42 }] }),
    );
    expect(out.contacts[0].disappearMs).toBe(HOUR);
    expect(out.contacts[0].disappearAt).toBe(42);
  });
});

describe("expiring history", () => {
  it("hides expired messages and the sweep deletes them with their kept files", async () => {
    const k = key();
    await appendMessage(k, "did:a", { text: "остава", direction: "out", timestamp: 1 });
    await appendMessage(k, "did:a", { text: "изчезва", direction: "in", timestamp: 2, expiresAt: 100 });
    await appendMessage(k, "did:a", { text: "още е тук", direction: "in", timestamp: 3, expiresAt: 10_000 });
    const card = { id: "AAAAAAAAAAA", name: "снимка.jpg", size: 3, mime: "image/jpeg", stored: true };
    await saveFile(k, "did:a", card.id, new Blob([new Uint8Array([1, 2, 3])]));
    await appendMessage(k, "did:a", { text: "", file: card, direction: "in", timestamp: 4, expiresAt: 100 });

    const visible = await loadHistory(k, "did:a", 500);
    expect(visible.map((m) => m.text)).toEqual(["остава", "още е тук"]);
    expect(visible[1].expiresAt).toBe(10_000);

    expect(await purgeExpired(500)).toBe(2);
    const rows = (await withStore<unknown[]>(STORE_MESSAGES, "readonly", (s) => s.getAll())) ?? [];
    expect(rows).toHaveLength(2);
    expect(await loadFile(k, "did:a", card.id)).toBeNull();
    // Nothing of the expired text is left in the database.
    expect(JSON.stringify(rows)).not.toContain("изчезва");

    expect(await purgeExpired(20_000)).toBe(1);
    expect((await loadHistory(k, "did:a", 20_000)).map((m) => m.text)).toEqual(["остава"]);
  });

  it("the expiry is authenticated: a row whose expiry was pushed back does not open", async () => {
    const k = key();
    await appendMessage(k, "did:a", { text: "x", direction: "in", timestamp: 5, expiresAt: 100 });
    await withStore(STORE_MESSAGES, "readwrite", (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) c.update({ ...(c.value as object), expiresAt: 99_999 });
      };
    });
    await expect(loadHistory(k, "did:a", 500)).rejects.toThrow();
  });

  it("messages written before timers existed still open", async () => {
    const k = key();
    await appendMessage(k, "did:a", { text: "стар", direction: "out", timestamp: 7 });
    expect((await loadHistory(k, "did:a")).map((m) => m.text)).toEqual(["стар"]);
  });

  it("the contact book keeps the timer", async () => {
    await unlockContacts(key());
    await saveContact({ did: "did:a", publicKey: new Uint8Array([1]), name: "А", verified: true, addedAt: 1, disappearMs: HOUR });
    expect((await getContact("did:a"))?.disappearMs).toBe(HOUR);
    await saveContact({ did: "did:b", publicKey: new Uint8Array([1]), name: "Б", verified: true, addedAt: 1, disappearMs: 123 });
    expect((await getContact("did:b"))?.disappearMs).toBeUndefined();
    lockContacts();
  });
});
