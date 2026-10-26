import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

vi.mock("../../src/identity/webauthn", async () => {
  const actual = await vi.importActual<typeof import("../../src/identity/webauthn")>("../../src/identity/webauthn");
  return {
    ...actual,
    isWebAuthnSupported: vi.fn(() => true),
    createPasskey: vi.fn(async () => ({
      credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
      prfSecret: new Uint8Array(32).fill(7),
    })),
    getPasskey: vi.fn(async () => ({
      credentialId: new Uint8Array([1, 2, 3, 4]).buffer,
      prfSecret: new Uint8Array(32).fill(7),
    })),
  };
});

// A tiny in-memory stand-in for WebRTC: two links wired together once the answer is applied.
vi.mock("../../src/p2p/peer", () => {
  const registry = new Map<string, FakeLink>();
  let counter = 0;
  class FakeLink {
    peer: FakeLink | null = null;
    handlers = new Set<(t: string) => void>();
    pending: string[] = [];
    closed = false;
    constructor(public sdp: string) {
      registry.set(sdp, this);
    }
    static async createOffer() {
      const link = new FakeLink(`offer-sdp-${++counter}`);
      return { link, sdp: link.sdp };
    }
    static async createAnswer(offerSdp: string) {
      const link = new FakeLink(`answer-sdp-${++counter}`);
      link.peer = registry.get(offerSdp) ?? null;
      return { link, sdp: link.sdp };
    }
    async acceptAnswer(answerSdp: string) {
      const other = registry.get(answerSdp);
      if (!other) throw new Error("no such peer");
      this.peer = other;
      other.peer = this;
    }
    async waitForOpen() {}
    send(text: string) {
      const to = this.peer;
      if (!to || to.closed) throw new Error("closed");
      queueMicrotask(() => {
        if (to.handlers.size === 0) to.pending.push(text);
        for (const h of [...to.handlers]) h(text);
      });
    }
    onMessage(h: (t: string) => void) {
      this.handlers.add(h);
      for (const t of this.pending.splice(0)) h(t);
      return () => this.handlers.delete(h);
    }
    closeHandlers = new Set<(r: string) => void>();
    onClose(h: (r: string) => void) {
      this.closeHandlers.add(h);
      return () => this.closeHandlers.delete(h);
    }
    fireClose() {
      const hs = [...this.closeHandlers];
      this.closeHandlers.clear();
      for (const h of hs) h("closed");
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.fireClose();
      // The far end notices too, as a real data channel would.
      const peer = this.peer;
      if (peer && !peer.closed) queueMicrotask(() => peer.close());
    }
  }
  return { PeerLink: FakeLink, CONNECT_TIMEOUT_MS: 30_000, PeerLinkError: class extends Error {} };
});

import { createIdentity } from "../../src/identity/identityService";
import { importSeedAsIdentity, unlockSeed } from "../../src/identity/seedTransfer";
import { loadIdentityRecord } from "../../src/identity/storage";
import { IdentityError } from "../../src/identity/types";
import { mnemonicToSeed } from "../../src/identity/mnemonic";
import { deriveHistoryKey } from "../../src/history/messageStore";
import { listContacts, lockContacts, saveContact, unlockContacts } from "../../src/contacts/contacts";
import { acceptAnswerText, answerOffer, beginSend } from "../../src/transfer/link";
import { TransferEndpoint } from "../../src/transfer/endpoint";
import { peerChannel } from "../../src/transfer/link";
import { TRANSFER_TTL_MS, decodeTransferPacket, encodeTransferPacket, newAnswer, newEphemeral } from "../../src/transfer/packet";
import { wipeThisDevice } from "../../src/transfer/wipe";
import { STORE_IDENTITY, STORE_CONTACTS_SEALED, withStore } from "../../src/db/database";
import { sampleContacts, waitFor } from "./helpers";

const PW = "correct horse battery";

function freshDevice() {
  // @ts-expect-error - assigning a fresh factory instance
  globalThis.indexedDB = new IDBFactory();
  lockContacts();
}

beforeEach(freshDevice);

describe("seed access", () => {
  it("unlockSeed returns the seed behind the mnemonic, after re-authentication", async () => {
    const created = await createIdentity(PW, { skipPasskey: true });
    const seed = await unlockSeed(PW);
    expect(Array.from(seed)).toEqual(Array.from(mnemonicToSeed(created.mnemonic)));
    await expect(unlockSeed("wrong password!!")).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    await expect(unlockSeed()).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("works for a passkey (PRF) identity", async () => {
    const created = await createIdentity();
    expect(created.usedPrf).toBe(true);
    const seed = await unlockSeed();
    expect(Array.from(seed)).toEqual(Array.from(mnemonicToSeed(created.mnemonic)));
  });

  it("import gives the same DID, with this device's own protection, and never overwrites", async () => {
    const created = await createIdentity(PW, { skipPasskey: true });
    const seed = await unlockSeed(PW);
    freshDevice();
    const imported = await importSeedAsIdentity(seed, "another password 123", { skipPasskey: true });
    expect(imported.did).toBe(created.identity.did);
    const rec = await loadIdentityRecord();
    expect(rec?.unlockMethod).toBe("password");
    await expect(importSeedAsIdentity(seed, "x".repeat(12), { skipPasskey: true })).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
    });
    await expect(importSeedAsIdentity(new Uint8Array(10), "x")).rejects.toBeInstanceOf(IdentityError);
  });

  it("the new device may choose a passkey while the old one used a password", async () => {
    await createIdentity(PW, { skipPasskey: true });
    const seed = await unlockSeed(PW);
    freshDevice();
    await importSeedAsIdentity(seed);
    expect((await loadIdentityRecord())?.unlockMethod).toBe("webauthn-prf");
  });
});

describe("signalling and one-time offers", () => {
  it("an offer takes exactly one answer; a replayed answer is refused", async () => {
    const send = await beginSend();
    const recv = await answerOffer(send.text);
    await acceptAnswerText(send, recv.text);
    await expect(acceptAnswerText(send, recv.text)).rejects.toMatchObject({ code: "REPLAYED" });
  });

  it("an answer made for another offer is refused and does not use up this offer", async () => {
    const send = await beginSend();
    const other = await beginSend();
    const wrong = await answerOffer(other.text);
    await expect(acceptAnswerText(send, wrong.text)).rejects.toMatchObject({ code: "WRONG_NONCE" });
    const right = await answerOffer(send.text);
    await expect(acceptAnswerText(send, right.text)).resolves.toBeDefined();
  });

  it("an offer scanned after it expired is refused by the new device", async () => {
    const send = await beginSend(Date.now() - TRANSFER_TTL_MS - 5 * 60_000);
    await expect(answerOffer(send.text)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("an answer arriving after expiry is refused by the old device", async () => {
    const send = await beginSend(Date.now() - TRANSFER_TTL_MS + 5_000);
    const recv = await answerOffer(send.text);
    await expect(acceptAnswerText(send, recv.text, Date.now() + 10 * 60_000)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("an offer text cannot be used as an answer, nor an answer as an offer", async () => {
    const send = await beginSend();
    await expect(acceptAnswerText(send, send.text)).rejects.toMatchObject({ code: "WRONG_KIND" });
    const recv = await answerOffer(send.text);
    await expect(answerOffer(recv.text)).rejects.toMatchObject({ code: "WRONG_KIND" });
  });

  it("an answer with a swapped ephemeral key gives different keys: the hello does not open", async () => {
    const send = await beginSend();
    const recv = await answerOffer(send.text);
    const real = await decodeTransferPacket(recv.text);
    const forged = await encodeTransferPacket(newAnswer(send.offer, real.sdp, newEphemeral().publicKey));
    const keys = await acceptAnswerText(send, forged);
    expect(keys.sasWords).not.toEqual(recv.keys.sasWords);
    const a = new TransferEndpoint({ keys, channel: peerChannel(send.link), ownDid: "d", getBundle: async () => ({ seed: new Uint8Array(64), contacts: [] }) });
    const b = new TransferEndpoint({ keys: recv.keys, channel: peerChannel(recv.link) });
    await a.start();
    await b.start();
    await Promise.all([waitFor(a, "failed", "aborted"), waitFor(b, "failed", "aborted")]);
    expect(b.bundle).toBeNull();
  });
});

describe("full move between two devices", () => {
  it("moves seed and contacts; the new device keeps the DID, then the old one is wiped", async () => {
    // Old device
    const created = await createIdentity(PW, { skipPasskey: true });
    await unlockContacts(deriveHistoryKey(created.identity));
    const contacts = sampleContacts(4);
    for (const c of contacts) await saveContact(c);
    const seed = await unlockSeed(PW);
    const oldIdb = globalThis.indexedDB;

    const send = await beginSend();
    const recv = await answerOffer(send.text);
    const keys = await acceptAnswerText(send, recv.text);
    const sender = new TransferEndpoint({
      keys,
      channel: peerChannel(send.link),
      ownDid: created.identity.did,
      getBundle: async () => ({ seed, contacts: await listContacts() }),
    });
    const receiver = new TransferEndpoint({ keys: recv.keys, channel: peerChannel(recv.link) });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    expect(sender.words).toEqual(receiver.words);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "received");

    // New device: its own database, its own unlock method.
    freshDevice();
    const bundle = receiver.bundle!;
    const identity = await importSeedAsIdentity(bundle.seed, "new device password", { skipPasskey: true });
    expect(identity.did).toBe(created.identity.did);
    await unlockContacts(deriveHistoryKey(identity));
    for (const c of bundle.contacts) await saveContact(c);
    const moved = await listContacts();
    expect(moved.map((c) => c.did).sort()).toEqual(contacts.map((c) => c.did).sort());
    expect(moved.find((c) => c.did === contacts[0].did)?.verified).toBe(true);
    await receiver.reportStored(identity.did);
    await waitFor(sender, "stored");

    // Old device: wipe after confirmation.
    globalThis.indexedDB = oldIdb;
    lockContacts();
    await wipeThisDevice();
    expect(await loadIdentityRecord()).toBeNull();
    const rows = await withStore<unknown[]>(STORE_CONTACTS_SEALED, "readonly", (s) => s.getAll());
    expect(rows).toEqual([]);
    const idRows = await withStore<unknown[]>(STORE_IDENTITY, "readonly", (s) => s.getAll());
    expect(idRows).toEqual([]);
  });

  it("when the SAS does not match, the new device never holds the seed", async () => {
    const created = await createIdentity(PW, { skipPasskey: true });
    const seed = await unlockSeed(PW);
    const getBundle = vi.fn(async () => ({ seed, contacts: [] }));
    const send = await beginSend();
    const recv = await answerOffer(send.text);
    const keys = await acceptAnswerText(send, recv.text);
    const sender = new TransferEndpoint({ keys, channel: peerChannel(send.link), ownDid: created.identity.did, getBundle });
    const receiver = new TransferEndpoint({ keys: recv.keys, channel: peerChannel(recv.link) });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await sender.confirmSas(true);
    await receiver.confirmSas(false);
    await waitFor(sender, "aborted");
    expect(getBundle).not.toHaveBeenCalled();
    expect(receiver.bundle).toBeNull();
    expect(await loadIdentityRecord()).not.toBeNull(); // the old device is untouched
  });
});
