import { beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { createIdentity } from "../../src/identity/identityService";
import { unlockSeed } from "../../src/identity/seedTransfer";
import { loadIdentityRecord } from "../../src/identity/storage";
import { deriveHistoryKey } from "../../src/history/messageStore";
import { listContacts, lockContacts } from "../../src/contacts/contacts";
import { completeReceive, newReceiveProgress } from "../../src/transfer/receive";
import { stopWritersAndWipe, wipeThisDevice } from "../../src/transfer/wipe";
import { GroupSession } from "../../src/group/groupSession";
import { newProposalId } from "../../src/p2p/suiteNegotiation";
import { STORE_GROUPS, withStore } from "../../src/db/database";
import { MAX_BUNDLE_BYTES, encodeBundle, type TransferBundle } from "../../src/transfer/bundle";
import { MAX_FRAME_CHARS, sealFrame } from "../../src/transfer/session";
import { bytesToBase64Url } from "../../src/p2p/encoding";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import type { Contact } from "../../src/contacts/contacts";
import { SEED, makeKeys, sampleContacts, setup, waitFor } from "./helpers";

const PW = "correct horse battery";

beforeEach(() => {
  // @ts-expect-error - assigning a fresh factory instance
  globalThis.indexedDB = new IDBFactory();
  lockContacts();
});

async function seedBundle(): Promise<{ bundle: TransferBundle; did: string }> {
  const created = await createIdentity(PW, { skipPasskey: true });
  const seed = await unlockSeed(PW);
  // @ts-expect-error - the new device: a fresh, empty database
  globalThis.indexedDB = new IDBFactory();
  lockContacts();
  return { bundle: { seed, contacts: sampleContacts(3) }, did: created.identity.did };
}

describe("new device: stored but not acknowledged (Codex P2 #1)", () => {
  it("an acknowledgement failure after import is reported, not thrown, and a retry does not import again", async () => {
    const { bundle, did } = await seedBundle();
    const progress = newReceiveProgress();
    const first = await completeReceive(
      bundle,
      progress,
      async () => {
        throw new Error("Data channel is not open.");
      },
      "new device password",
      { skipPasskey: true },
    );
    expect(first.acknowledged).toBe(false);
    expect(first.identity.did).toBe(did);
    expect((await loadIdentityRecord())?.did).toBe(did);
    expect((await listContacts()).length).toBe(3);

    // Retry with the same progress: no ALREADY_EXISTS, no second import, the ack goes out.
    const ack = vi.fn(async () => undefined);
    const second = await completeReceive(bundle, progress, ack, "new device password", { skipPasskey: true });
    expect(second.acknowledged).toBe(true);
    expect(second.identity.did).toBe(did);
    expect(ack).toHaveBeenCalledWith(did);
  });

  it("the real endpoint: a closed channel after storing gives acknowledged=false, the sender is not told 'stored'", async () => {
    const { bundle: local, did } = await seedBundle();
    const { sender, receiver, ch } = setup({ ownDid: did });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "received");
    // The channel dies while the person chooses an unlock method.
    ch.b.send = () => {
      throw new Error("Data channel is not open.");
    };
    const result = await completeReceive(
      { ...receiver.bundle!, seed: local.seed },
      newReceiveProgress(),
      (d) => receiver.reportStored(d),
      "new device password",
      { skipPasskey: true },
    );
    expect(result.acknowledged).toBe(false);
    expect(result.identity.did).toBe(did);
    expect(sender.state).not.toBe("stored"); // so the old device never offers the wipe
  });
});

describe("old device: background group writes vs wipe (Codex P2 #2)", () => {
  async function groupRows(): Promise<number> {
    return ((await withStore<unknown[]>(STORE_GROUPS, "readonly", (s) => s.getAll())) ?? []).length;
  }

  it("without draining, a queued group save puts data back after the wipe (the bug)", async () => {
    const created = await createIdentity(PW, { skipPasskey: true });
    const historyKey = deriveHistoryKey(created.identity);
    const group = GroupSession.create(created.identity.keyPair, newProposalId(), "Група", "Аз", { historyKey });
    await wipeThisDevice();
    group.closeAll();
    await group.flush();
    expect(await groupRows()).toBeGreaterThan(0);
  });

  it("stopWritersAndWipe stops the group and waits for its saves first: storage stays empty", async () => {
    const created = await createIdentity(PW, { skipPasskey: true });
    const historyKey = deriveHistoryKey(created.identity);
    const group = GroupSession.create(created.identity.keyPair, newProposalId(), "Група", "Аз", { historyKey });
    await stopWritersAndWipe([group, null]);
    await group.flush();
    expect(await groupRows()).toBe(0);
    expect(await loadIdentityRecord()).toBeNull();
  });
});

describe("bundle size vs frame size (Codex P2 #3)", () => {
  function bigContacts(): Contact[] {
    // 3-byte UTF-8 characters, long names: grow until the next contact no longer fits.
    const out: Contact[] = [];
    for (let i = 0; ; i++) {
      const kp = deriveIdentityKeyPair(new Uint8Array(64).fill(i % 250).map((b, j) => (j === 0 ? i >> 8 : b)));
      const c: Contact = {
        did: publicKeyToDidKey(kp.publicKey),
        publicKey: kp.publicKey,
        name: "漢".repeat(200),
        verified: true,
        verifiedAt: 1,
        addedAt: 2,
      };
      try {
        encodeBundle({ seed: SEED, contacts: [...out, c] });
      } catch {
        return out;
      }
      out.push(c);
    }
  }

  it("the largest bundle encodeBundle accepts still fits in one frame and arrives", async () => {
    const contacts = bigContacts();
    const bytes = encodeBundle({ seed: SEED, contacts });
    expect(bytes.length).toBeGreaterThan(MAX_BUNDLE_BYTES - 2048);
    expect(bytes.length).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);

    // A frame exactly at the cap, the way maybeRelease builds it.
    const max = new Uint8Array(MAX_BUNDLE_BYTES);
    const frame = await sealFrame(makeKeys().sender, 1, { t: "bundle", d: bytesToBase64Url(max) });
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_CHARS);
    expect(MAX_FRAME_CHARS).toBeLessThanOrEqual(256 * 1024); // safe data-channel message size

    const { sender, receiver } = setup({ contacts });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    expect(await waitFor(receiver, "received", "failed")).toBe("received");
    expect(receiver.bundle!.contacts).toHaveLength(contacts.length);
  });
});
