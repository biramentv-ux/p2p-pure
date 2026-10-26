import { describe, expect, it } from "vitest";
import { MAX_CONTACTS } from "../../src/transfer/bundle";
import { TRANSFER_TTL_MS } from "../../src/transfer/packet";
import { openFrame, sealFrame } from "../../src/transfer/session";
import { makeKeys, sampleContacts, setup, waitFor } from "./helpers";

async function toCompare(s: ReturnType<typeof setup>) {
  await s.sender.start();
  await s.receiver.start();
  await Promise.all([waitFor(s.sender, "compare"), waitFor(s.receiver, "compare")]);
}

describe("channel closes after it opened (Codex P2: link.ts)", () => {
  it("during the comparison: both sides fail visibly with CLOSED", async () => {
    const s = setup();
    await toCompare(s);
    s.ch.a.kill();
    await Promise.all([waitFor(s.sender, "failed"), waitFor(s.receiver, "failed")]);
    expect(s.sender.error?.code).toBe("CLOSED");
    expect(s.receiver.error?.code).toBe("CLOSED");
  });

  it("after the bundle left: the old device stops waiting and says it was not wiped", async () => {
    const s = setup();
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    expect(s.sender.state).toBe("sending");
    s.ch.a.kill();
    await waitFor(s.sender, "failed");
    expect(s.sender.error?.code).toBe("CLOSED");
    expect(s.sender.error?.message).toMatch(/не е изтрито/);
  });

  it("the new device keeps a received bundle when the channel dies (it can still store it)", async () => {
    const s = setup();
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    s.ch.b.kill();
    await new Promise((r) => setTimeout(r, 10));
    expect(s.receiver.state).toBe("received");
    expect(s.receiver.bundle).not.toBeNull();
    expect(s.receiver.peerEnded).toBe(true);
    // The ack cannot reach anyone: it throws, so the screen shows "not confirmed, not wiped".
    await expect(s.receiver.reportStored("did:key:zOwn")).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("a close that arrives right behind the final `stored` frame still ends in stored", async () => {
    const s = setup();
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    const ack = s.receiver.reportStored(s.ownDid);
    await ack;
    s.ch.a.fireClose(); // the close event races the frame still being decrypted
    await new Promise((r) => setTimeout(r, 30));
    expect(s.sender.state).toBe("stored");
  });

  it("a normal end (stored) is not turned into a failure by the closing channel", async () => {
    const s = setup();
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    await s.receiver.reportStored(s.ownDid);
    await waitFor(s.sender, "stored");
    s.ch.a.kill();
    await new Promise((r) => setTimeout(r, 80));
    expect(s.sender.state).toBe("stored");
    expect(s.receiver.state).toBe("stored");
  });
});

describe("protocol deadline", () => {
  const soon = () => makeKeys({ now: Date.now() - TRANSFER_TTL_MS + 150 });

  it("nobody waits past the expiry: a comparison left open fails with EXPIRED", async () => {
    const s = setup({ keys: soon() });
    await toCompare(s);
    await Promise.all([waitFor(s.sender, "failed"), waitFor(s.receiver, "failed", "aborted")]);
    expect(s.sender.error?.code).toBe("EXPIRED");
  });

  it("the old device waiting for the stored ack stops at the expiry and is not wiped", async () => {
    const s = setup({ keys: soon() });
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    await waitFor(s.sender, "failed");
    expect(s.sender.error?.code).toBe("EXPIRED");
    expect(s.sender.error?.message).toMatch(/не е изтрито/);
    // Let the sender's last frame and its channel close actually reach the new device.
    await new Promise((r) => setTimeout(r, 120));
    const last = s.ch.a.sent[s.ch.a.sent.length - 1];
    await expect(openFrame(s.keys.receiver, 2, last)).resolves.toEqual({ t: "gone" }); // not `abort`
    expect(s.receiver.state).toBe("received");
    expect(s.receiver.bundle).not.toBeNull();
    expect(s.receiver.peerEnded).toBe(true);
    await expect(s.receiver.reportStored(s.ownDid)).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("a deadline while the contacts are still being read: the seed is never sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({
      keys: soon(),
      getBundle: async () => {
        await gate;
        return { seed: new Uint8Array(64).fill(1), contacts: [] };
      },
    });
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await new Promise((r) => setTimeout(r, 5));
    const confirming = s.sender.confirmSas(true);
    await waitFor(s.sender, "failed");
    release();
    await confirming;
    await new Promise((r) => setTimeout(r, 30));
    expect(s.sender.error?.code).toBe("EXPIRED");
    expect(s.ch.a.sent).toHaveLength(2); // hello + abort, no bundle after the failure
    expect(s.receiver.bundle).toBeNull();
  });
});

describe("a received bundle survives whatever comes after it", () => {
  async function received() {
    const s = setup();
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await s.sender.confirmSas(true);
    await waitFor(s.receiver, "received");
    return s;
  }

  it("an explicit abort frame from the old device", async () => {
    const s = await received();
    s.ch.b.deliver(await sealFrame(s.keys.sender, 2, { t: "abort" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(s.receiver.state).toBe("received");
    expect(s.receiver.bundle).not.toBeNull();
    expect(s.receiver.peerEnded).toBe(true);
  });

  it("a frame that does not open", async () => {
    const s = await received();
    s.ch.b.deliver("{not a frame");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.receiver.state).toBe("received");
    expect(s.receiver.bundle).not.toBeNull();
  });

  it("the sender never sends abort once the bundle left (e.g. a bad frame after release)", async () => {
    const s = await received();
    const before = s.ch.a.sent.length;
    s.ch.a.deliver("{garbage");
    await waitFor(s.sender, "failed");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.ch.a.sent.length).toBe(before);
  });
});

describe("failures inside confirmSas (Codex P2: endpoint.ts)", () => {
  it("reading the contacts fails: the sender fails, the promise resolves, the peer is told", async () => {
    const s = setup({
      getBundle: async () => {
        throw new Error("IndexedDB read failed");
      },
    });
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await new Promise((r) => setTimeout(r, 10));
    await expect(s.sender.confirmSas(true)).resolves.toBeUndefined();
    expect(s.sender.state).toBe("failed");
    expect(s.sender.error?.code).toBe("SEND_FAILED");
    await waitFor(s.receiver, "aborted");
    expect(s.receiver.bundle).toBeNull();
  });

  it("a bundle that is too large fails before anything is released", async () => {
    const s = setup({ contacts: sampleContacts(MAX_CONTACTS + 1) });
    await toCompare(s);
    await s.receiver.confirmSas(true);
    await new Promise((r) => setTimeout(r, 10));
    await s.sender.confirmSas(true);
    expect(s.sender.state).toBe("failed");
    expect(s.sender.error?.code).toBe("BAD_BUNDLE");
    await new Promise((r) => setTimeout(r, 10));
    expect(s.ch.a.sent).toHaveLength(2); // hello + abort, never a bundle
  });

  it("the sender confirms last and the bundle is too large (release from receive path)", async () => {
    const s = setup({ contacts: sampleContacts(MAX_CONTACTS + 1) });
    await toCompare(s);
    await s.sender.confirmSas(true);
    await s.receiver.confirmSas(true);
    await waitFor(s.sender, "failed");
    expect(s.sender.error?.code).toBe("BAD_BUNDLE");
  });

  it("sending sas-ok fails: the new device fails instead of an unhandled rejection", async () => {
    const s = setup();
    await toCompare(s);
    s.ch.b.send = () => {
      throw new Error("Data channel is not open.");
    };
    await expect(s.receiver.confirmSas(true)).resolves.toBeUndefined();
    expect(s.receiver.state).toBe("failed");
    expect(s.receiver.error?.code).toBe("SEND_FAILED");
  });
});
