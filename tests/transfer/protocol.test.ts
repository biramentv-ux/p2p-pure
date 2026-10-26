import { describe, expect, it } from "vitest";
import { decodeBundle, encodeBundle, MAX_CONTACTS } from "../../src/transfer/bundle";
import {
  CLOCK_SKEW_MS,
  TRANSFER_PREFIX,
  TRANSFER_TTL_MS,
  TransferError,
  decodeTransferPacket,
  encodeTransferPacket,
  encodeTransferPacketHex,
  newAnswer,
  newEphemeral,
  newOffer,
} from "../../src/transfer/packet";
import { deriveTransferKeys, openFrame, sealFrame } from "../../src/transfer/session";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { bytesToBase64Url } from "../../src/p2p/encoding";
import { SEED, makeKeys, sampleContacts, setup, waitFor } from "./helpers";

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("packet codec", () => {
  it("round-trips an offer as base64url and as hex", async () => {
    const eph = newEphemeral();
    const offer = newOffer("v=0\r\na=fingerprint:sha-256 AA:BB\r\n", eph.publicKey);
    const text = await encodeTransferPacket(offer);
    expect(text.startsWith(TRANSFER_PREFIX)).toBe(true);
    for (const form of [text, await encodeTransferPacketHex(offer)]) {
      const back = await decodeTransferPacket(form);
      expect(back.kind).toBe("offer");
      expect(back.sdp).toBe(offer.sdp);
      expect(Array.from(back.nonce)).toEqual(Array.from(offer.nonce));
      expect(Array.from(back.ephemeralPublicKey)).toEqual(Array.from(eph.publicKey));
      expect(back.expiresAt).toBe(offer.expiresAt);
    }
  });

  it("carries no identity: no DID, no signature field", async () => {
    const offer = newOffer("v=0", newEphemeral().publicKey);
    const text = await encodeTransferPacket(offer);
    expect(text).not.toContain("did:key");
    expect(Object.keys(offer).sort()).toEqual(["ephemeralPublicKey", "expiresAt", "kind", "nonce", "sdp"]);
  });

  it("refuses an expired code, with a tolerance for clock skew", async () => {
    const t0 = 1_000_000_000_000;
    const text = await encodeTransferPacket(newOffer("v=0", newEphemeral().publicKey, t0));
    const exp = t0 + TRANSFER_TTL_MS;
    await expect(decodeTransferPacket(text, exp + CLOCK_SKEW_MS - 1)).resolves.toBeDefined();
    await expect(decodeTransferPacket(text, exp + CLOCK_SKEW_MS + 1)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("refuses garbage, other prefixes, truncation and an all-zero key", async () => {
    for (const bad of ["", "hello", "p2p1:AAAA", "p2pt1:%%%", "p2pt1:AAAA", "p2pt1h:zz", "p2pt1h:abc"]) {
      await expect(decodeTransferPacket(bad)).rejects.toBeInstanceOf(TransferError);
    }
    const zero = newOffer("v=0", new Uint8Array(32).fill(0));
    await expect(encodeTransferPacket(zero)).rejects.toMatchObject({ code: "BAD_KEY" });
  });

  it("an answer repeats the nonce and expiry of its offer", () => {
    const offer = newOffer("o", newEphemeral().publicKey);
    const answer = newAnswer(offer, "a", newEphemeral().publicKey);
    expect(Array.from(answer.nonce)).toEqual(Array.from(offer.nonce));
    expect(answer.expiresAt).toBe(offer.expiresAt);
  });
});

describe("key agreement", () => {
  it("both sides derive the same keys and the same 6 words", () => {
    const k = makeKeys();
    expect(k.sender.sasWords).toHaveLength(6);
    expect(k.sender.sasWords).toEqual(k.receiver.sasWords);
    expect(Array.from(k.sender.keySenderToReceiver)).toEqual(Array.from(k.receiver.keySenderToReceiver));
    expect(Array.from(k.sender.keySenderToReceiver)).not.toEqual(Array.from(k.sender.keyReceiverToSender));
  });

  it("a different SDP changes the words and the keys (SDP is in the transcript)", () => {
    const eS = newEphemeral();
    const eR = newEphemeral();
    const offer = newOffer("sdp-offer", eS.publicKey);
    const answer = newAnswer(offer, "sdp-answer", eR.publicKey);
    const swapped = { ...answer, sdp: "attacker-sdp" };
    const s = deriveTransferKeys("sender", eS.secretKey, offer, swapped);
    const r = deriveTransferKeys("receiver", eR.secretKey, offer, answer);
    expect(s.sasWords).not.toEqual(r.sasWords);
    expect(Array.from(s.keySenderToReceiver)).not.toEqual(Array.from(r.keySenderToReceiver));
  });

  it("rejects an answer for another offer and wrong kinds", () => {
    const eS = newEphemeral();
    const eR = newEphemeral();
    const offer = newOffer("o", eS.publicKey);
    const other = newOffer("o2", newEphemeral().publicKey);
    const answer = newAnswer(other, "a", eR.publicKey);
    expect(() => deriveTransferKeys("sender", eS.secretKey, offer, answer)).toThrowError(
      expect.objectContaining({ code: "WRONG_NONCE" }),
    );
    expect(() => deriveTransferKeys("sender", eS.secretKey, answer, offer)).toThrowError(
      expect.objectContaining({ code: "WRONG_KIND" }),
    );
  });

  it("rejects a low-order peer key", () => {
    const eS = newEphemeral();
    const offer = newOffer("o", eS.publicKey);
    // Point of order 1 (u = 1) yields an all-zero shared secret.
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = 1;
    const answer = newAnswer(offer, "a", lowOrder);
    expect(() => deriveTransferKeys("sender", eS.secretKey, offer, answer)).toThrowError(
      expect.objectContaining({ code: "BAD_KEY" }),
    );
  });

  it("a man in the middle that terminates both sessions gets different words on each side", () => {
    const eA = newEphemeral(); // old device
    const eB = newEphemeral(); // new device
    const m1 = newEphemeral(); // attacker towards the old device
    const m2 = newEphemeral(); // attacker towards the new device
    const offer = newOffer("sdp-A", eA.publicKey);
    const answerFromB = newAnswer(offer, "sdp-B", eB.publicKey);
    const offerSeenByB = newOffer("sdp-M2", m2.publicKey);
    const answerSeenByA = { ...newAnswer(offer, "sdp-M1", m1.publicKey) };
    const a = deriveTransferKeys("sender", eA.secretKey, offer, answerSeenByA);
    const b = deriveTransferKeys(
      "receiver",
      eB.secretKey,
      offerSeenByB,
      newAnswer(offerSeenByB, answerFromB.sdp, eB.publicKey),
    );
    expect(a.sasWords).not.toEqual(b.sasWords);
  });
});

describe("frames", () => {
  it("opens only in order, only in the right direction, only once", async () => {
    const k = makeKeys();
    const f0 = await sealFrame(k.sender, 0, { t: "hello" });
    await expect(openFrame(k.receiver, 0, f0)).resolves.toEqual({ t: "hello" });
    await expect(openFrame(k.receiver, 1, f0)).rejects.toMatchObject({ code: "TAMPERED" }); // replay at a later counter
    await expect(openFrame(k.sender, 0, f0)).rejects.toMatchObject({ code: "TAMPERED" }); // reflected back
  });

  it("rejects a flipped ciphertext bit", async () => {
    const k = makeKeys();
    const f = JSON.parse(await sealFrame(k.sender, 0, { t: "hello" })) as { c: string; n: number; p2pt: number };
    const chars = f.c.split("");
    chars[2] = chars[2] === "A" ? "B" : "A";
    f.c = chars.join("");
    await expect(openFrame(k.receiver, 0, JSON.stringify(f))).rejects.toMatchObject({ code: "TAMPERED" });
  });

  it("rejects frames from another session", async () => {
    const a = makeKeys();
    const b = makeKeys();
    const f = await sealFrame(a.sender, 0, { t: "hello" });
    await expect(openFrame(b.receiver, 0, f)).rejects.toMatchObject({ code: "TAMPERED" });
  });
});

describe("bundle", () => {
  it("round-trips seed and contacts and pads to 1 KiB blocks", () => {
    const contacts = sampleContacts(5);
    const bytes = encodeBundle({ seed: SEED, contacts });
    expect(bytes.length % 1024).toBe(0);
    const back = decodeBundle(bytes);
    expect(Array.from(back.seed)).toEqual(Array.from(SEED));
    expect(back.contacts).toHaveLength(5);
    expect(back.contacts[1]).toEqual(contacts[1]);
    expect(encodeBundle({ seed: SEED, contacts: sampleContacts(1) }).length).toBe(
      encodeBundle({ seed: SEED, contacts: sampleContacts(2) }).length,
    );
  });

  it("rejects a bad seed length, too many contacts, and a DID that does not match its key", () => {
    expect(() => encodeBundle({ seed: new Uint8Array(32), contacts: [] })).toThrow();
    expect(() => encodeBundle({ seed: SEED, contacts: sampleContacts(MAX_CONTACTS + 1) })).toThrow();
    const [c] = sampleContacts(1);
    const forged = { ...c, did: publicKeyToDidKey(new Uint8Array(32).fill(9)) };
    expect(() => decodeBundle(encodeBundle({ seed: SEED, contacts: [forged] }))).toThrowError(
      expect.objectContaining({ code: "BAD_BUNDLE" }),
    );
    expect(() => decodeBundle(new Uint8Array(1024))).toThrow();
    expect(() => decodeBundle(new Uint8Array(3))).toThrow();
  });

  it("rejects duplicate DIDs", () => {
    const [c] = sampleContacts(1);
    expect(() => decodeBundle(encodeBundle({ seed: SEED, contacts: [c, c] }))).toThrow();
  });
});

describe("protocol over a channel", () => {
  it("happy path: both confirm, bundle arrives, sender sees the stored ack", async () => {
    const { sender, receiver, contacts, ownDid } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    expect(sender.words).toEqual(receiver.words);

    await receiver.confirmSas(true);
    await tick();
    expect(sender.state).toBe("compare"); // the old device's user has not confirmed yet
    await sender.confirmSas(true);
    await waitFor(receiver, "received");
    expect(Array.from(receiver.bundle!.seed)).toEqual(Array.from(SEED));
    expect(receiver.bundle!.contacts.map((c) => c.did)).toEqual(contacts.map((c) => c.did));

    await receiver.reportStored(ownDid);
    await waitFor(sender, "stored");
    expect(receiver.state).toBe("stored");
  });

  it("works when the sender confirms first", async () => {
    const { sender, receiver } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await sender.confirmSas(true);
    await tick();
    expect(sender.state).toBe("waiting-peer");
    await receiver.confirmSas(true);
    await waitFor(receiver, "received");
  });

  it("never releases the seed before both users confirm", async () => {
    const { sender, receiver, ch } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await sender.confirmSas(true);
    await tick();
    // Only the sender's own confirmation: nothing but the hello frame left the old device.
    expect(ch.a.sent).toHaveLength(1);
    expect(receiver.bundle).toBeNull();
  });

  it("wrong SAS on the new device: the old device aborts and sends nothing", async () => {
    const { sender, receiver, ch } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await sender.confirmSas(true);
    await receiver.confirmSas(false);
    await waitFor(sender, "aborted");
    expect(receiver.state).toBe("aborted");
    expect(receiver.error?.code).toBe("SAS_MISMATCH");
    expect(ch.a.sent).toHaveLength(1);
    expect(receiver.bundle).toBeNull();
  });

  it("wrong SAS on the old device: the new device aborts, no seed leaves", async () => {
    const { sender, receiver, ch } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(false);
    await waitFor(receiver, "aborted");
    expect(ch.a.sent).toHaveLength(2); // hello + abort, never a bundle
    expect(receiver.bundle).toBeNull();
  });

  it("different SDPs on the two sides (a middlebox): the hello does not open, nothing is sent", async () => {
    const k = makeKeys();
    const eR = newEphemeral();
    // The receiver saw another offer SDP than the sender made.
    const offerSeen = { ...k.offer, sdp: "swapped" };
    const answerSeen = newAnswer(offerSeen, "x", eR.publicKey);
    const forged = deriveTransferKeys("receiver", eR.secretKey, offerSeen, answerSeen);
    const { sender, receiver, ch } = setup({ keys: { ...k, receiver: forged } });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "failed", "aborted"), waitFor(receiver, "failed", "aborted")]);
    expect(sender.error?.code).toBe("TAMPERED");
    expect(ch.a.sent.length + ch.b.sent.length).toBeLessThanOrEqual(4);
    expect(receiver.bundle).toBeNull();
  });

  it("a tampered bundle frame fails the transfer and stores nothing", async () => {
    const { sender, receiver } = setup({
      tap(text, from) {
        if (from !== "a") return text;
        const f = JSON.parse(text) as { n: number; c: string };
        if (f.n !== 1) return text; // frame 1 from the sender is the bundle
        f.c = f.c.slice(0, 10) + (f.c[10] === "A" ? "B" : "A") + f.c.slice(11);
        return JSON.stringify(f);
      },
    });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "failed");
    expect(receiver.error?.code).toBe("TAMPERED");
    expect(receiver.bundle).toBeNull();
    await waitFor(sender, "failed", "aborted");
  });

  it("replaying a captured frame ends the transfer", async () => {
    const { sender, receiver, ch } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    ch.a.deliver(ch.b.sent[0]); // the receiver's hello again, delivered to the sender
    await waitFor(sender, "failed");
    expect(sender.error?.code).toBe("TAMPERED");
  });

  it("a replayed sas-ok does not release a second bundle", async () => {
    const { sender, receiver, ch, keys } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "received");
    const before = ch.a.sent.length;
    ch.a.deliver(ch.b.sent[1]); // replay of sas-ok
    await tick();
    expect(sender.state).toBe("failed");
    // The only thing the sender wrote afterwards is an abort, never a second bundle.
    expect(ch.a.sent.length).toBe(before + 1);
    await expect(openFrame(keys.receiver, 2, ch.a.sent[before])).resolves.toEqual({ t: "abort" });
  });

  it("a bundle that arrives before the new device's user confirmed is refused", async () => {
    const { receiver, ch, keys } = setup();
    await receiver.start();
    ch.b.deliver(await sealFrame(keys.sender, 0, { t: "hello" }));
    await waitFor(receiver, "compare");
    const bundle = bytesToBase64Url(encodeBundle({ seed: SEED, contacts: [] }));
    ch.b.deliver(await sealFrame(keys.sender, 1, { t: "bundle", d: bundle }));
    await waitFor(receiver, "failed");
    expect(receiver.error?.code).toBe("BAD_STATE");
    expect(receiver.bundle).toBeNull();
  });

  it("expiry: confirming after the deadline sends nothing", async () => {
    let now = Date.now();
    const clock = () => now;
    const { sender, receiver, ch } = setup({ now: clock });
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    now += TRANSFER_TTL_MS + 1;
    await sender.confirmSas(true);
    expect(sender.state).toBe("failed");
    expect(sender.error?.code).toBe("EXPIRED");
    expect(ch.a.sent.every((s) => s.length < 400)).toBe(true); // hello + abort only
    expect(receiver.bundle).toBeNull();
  });

  it("the sender refuses a stored ack that names another identity", async () => {
    const { sender, receiver } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "received");
    await receiver.reportStored("did:key:zSomeoneElse");
    await waitFor(sender, "failed");
    expect(sender.error?.code).toBe("IDENTITY_MISMATCH");
  });

  it("the sender stays intact when the new device reports failure", async () => {
    const { sender, receiver } = setup();
    await sender.start();
    await receiver.start();
    await Promise.all([waitFor(sender, "compare"), waitFor(receiver, "compare")]);
    await receiver.confirmSas(true);
    await sender.confirmSas(true);
    await waitFor(receiver, "received");
    await receiver.reportFailed();
    await waitFor(sender, "failed");
    expect(sender.state).not.toBe("stored");
  });

  it("confirmSas outside the compare state throws", async () => {
    const { receiver } = setup();
    await expect(receiver.confirmSas(true)).rejects.toMatchObject({ code: "BAD_STATE" });
  });
});
