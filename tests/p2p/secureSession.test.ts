import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import {
  createEphemeralKeyPair,
  isEncryptedMessage,
  MAX_SKIP,
  SecureSession,
  SessionError,
} from "../../src/p2p/secureSession";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));

/** Builds both ends of one session, as the QR handshake would. */
function pair() {
  const ephA = createEphemeralKeyPair();
  const ephB = createEphemeralKeyPair();
  const initiator = SecureSession.derive({
    role: "initiator",
    myIdentity: alice,
    myEphemeral: ephA,
    peerIdentityPublicKey: bob.publicKey,
    peerEphemeralPublicKey: ephB.publicKey,
  });
  const responder = SecureSession.derive({
    role: "responder",
    myIdentity: bob,
    myEphemeral: ephB,
    peerIdentityPublicKey: alice.publicKey,
    peerEphemeralPublicKey: ephA.publicKey,
  });
  return { initiator, responder, ephA, ephB };
}

describe("SecureSession", () => {
  it("both sides derive compatible keys: a message goes both ways", async () => {
    const { initiator, responder } = pair();
    expect(await responder.open(await initiator.seal("здравей"))).toBe("здравей");
    expect(await initiator.open(await responder.seal("здрасти, Алиса"))).toBe("здрасти, Алиса");
  });

  it("handles a long back-and-forth conversation in order", async () => {
    const { initiator, responder } = pair();
    for (let i = 0; i < 30; i++) {
      const a = `A${i}`;
      const b = `B${i}`;
      expect(await responder.open(await initiator.seal(a))).toBe(a);
      expect(await initiator.open(await responder.seal(b))).toBe(b);
    }
  });

  it("never puts plaintext on the wire", async () => {
    const { initiator } = pair();
    const wire = await initiator.seal("тайна парола 12345");
    expect(wire).not.toContain("тайна");
    expect(wire).not.toContain("12345");
    expect(isEncryptedMessage(wire)).toBe(true);
  });

  it("uses a different ciphertext for the same text every time", async () => {
    const { initiator } = pair();
    const w1 = await initiator.seal("same");
    const w2 = await initiator.seal("same");
    expect(w1).not.toBe(w2);
  });

  it("rejects a tampered ciphertext", async () => {
    const { initiator, responder } = pair();
    const wire = JSON.parse(await initiator.seal("hello")) as { ct: string };
    const flipped = wire.ct[0] === "A" ? "B" + wire.ct.slice(1) : "A" + wire.ct.slice(1);
    wire.ct = flipped;
    await expect(responder.open(JSON.stringify(wire))).rejects.toBeInstanceOf(SessionError);
  });

  it("rejects a replayed message", async () => {
    const { initiator, responder } = pair();
    const wire = await initiator.seal("once");
    expect(await responder.open(wire)).toBe("once");
    await expect(responder.open(wire)).rejects.toThrow(/counter/);
  });

  it("accepts a message that skips ahead, and decrypts the skipped one later", async () => {
    // Changed: the strict in-order check is replaced by a bounded skipped-key cache.
    const { initiator, responder } = pair();
    const lost = await initiator.seal("late");
    const second = await initiator.seal("second");
    expect(await responder.open(second)).toBe("second");
    expect(await responder.open(lost)).toBe("late");
  });

  it("rejects a message whose counter is more than MAX_SKIP ahead", async () => {
    const { initiator, responder } = pair();
    for (let i = 0; i <= MAX_SKIP; i++) await initiator.seal("skipped");
    const far = await initiator.seal("too far"); // counter MAX_SKIP + 1
    await expect(responder.open(far)).rejects.toThrow(/counter/);
  });

  it("accepts a message exactly MAX_SKIP ahead", async () => {
    const { initiator, responder } = pair();
    for (let i = 0; i < MAX_SKIP; i++) await initiator.seal("skipped");
    expect(await responder.open(await initiator.seal("edge"))).toBe("edge"); // counter MAX_SKIP
  });

  it("delivers 3 messages out of order: 3rd, 1st, 2nd", async () => {
    const { initiator, responder } = pair();
    const w1 = await initiator.seal("one");
    const w2 = await initiator.seal("two");
    const w3 = await initiator.seal("three");
    expect(await responder.open(w3)).toBe("three");
    expect(await responder.open(w1)).toBe("one");
    expect(await responder.open(w2)).toBe("two");
  });

  it("a skipped message key is used only once", async () => {
    const { initiator, responder } = pair();
    const w1 = await initiator.seal("one");
    const w2 = await initiator.seal("two");
    await responder.open(w2);
    expect(await responder.open(w1)).toBe("one");
    await expect(responder.open(w1)).rejects.toThrow(/counter/);
  });

  it("keeps working across many direction switches with a fresh dh key each time", async () => {
    const { initiator, responder } = pair();
    const burstStartDh: string[] = [];
    let sender = initiator;
    let receiver = responder;
    let prevSender: SecureSession | null = null;
    let count = 0;
    let switches = 0;
    while (count < 20) {
      const burst = 1 + (count % 3);
      for (let i = 0; i < burst && count < 20; i++, count++) {
        const text = `m${count}`;
        const wire = await sender.seal(text);
        if (i === 0) burstStartDh.push((JSON.parse(wire) as { dh: string }).dh);
        expect(await receiver.open(wire)).toBe(text);
      }
      [sender, receiver] = [receiver, sender];
      prevSender = receiver;
      switches++;
    }
    expect(prevSender).not.toBeNull();
    expect(switches).toBeGreaterThanOrEqual(3);
    // Every burst starts with a new ratchet key.
    expect(new Set(burstStartDh).size).toBe(burstStartDh.length);
  });

  it("wire format carries n, pn and dh and no plaintext", async () => {
    const { initiator, responder } = pair();
    await responder.open(await initiator.seal("first"));
    const wire = await responder.seal("секретен отговор");
    expect(wire).not.toContain("секретен");
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["t", "s", "n", "pn", "dh", "iv", "ct"]);
    expect(parsed.n).toBe(0);
    expect(typeof parsed.dh).toBe("string");
    expect(isEncryptedMessage(wire)).toBe(true);
  });

  it("rejects a message sent in the wrong direction", async () => {
    const { initiator, responder } = pair();
    // The initiator's own outgoing message, fed back to the initiator, must fail.
    const wire = await initiator.seal("echo");
    await expect(initiator.open(wire)).rejects.toBeInstanceOf(SessionError);
    expect(await responder.open(wire)).toBe("echo");
  });

  it("a session from other keys cannot read messages", async () => {
    const { initiator } = pair();
    const mallory = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
    const eve = SecureSession.derive({
      role: "responder",
      myIdentity: mallory,
      myEphemeral: createEphemeralKeyPair(),
      peerIdentityPublicKey: alice.publicKey,
      peerEphemeralPublicKey: createEphemeralKeyPair().publicKey,
    });
    await expect(eve.open(await initiator.seal("secret"))).rejects.toBeInstanceOf(SessionError);
  });

  it("new ephemeral keys give an independent session (forward secrecy per session)", async () => {
    const first = pair();
    const second = pair();
    const wire = await first.initiator.seal("old session");
    await expect(second.responder.open(wire)).rejects.toBeInstanceOf(SessionError);
  });

  it("rejects overly long plaintext", async () => {
    const { initiator } = pair();
    await expect(initiator.seal("x".repeat(4001))).rejects.toBeInstanceOf(SessionError);
  });

  it("rejects malformed wire input", async () => {
    const { responder } = pair();
    await expect(responder.open("not json")).rejects.toBeInstanceOf(SessionError);
    await expect(responder.open('{"t":"hello","did":"x"}')).rejects.toBeInstanceOf(SessionError);
  });
});
