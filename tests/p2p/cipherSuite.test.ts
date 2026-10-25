import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { createEphemeralKeyPair, SecureSession } from "../../src/p2p/secureSession";
import { aeadOpen, aeadSeal, suiteFromWireTag, suiteWireTag } from "../../src/p2p/cipherSuite";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));

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
  return { initiator, responder };
}

describe("cipher suites", () => {
  it("both suites round-trip the same plaintext", async () => {
    const key = new Uint8Array(32).map((_, i) => i);
    const iv = new Uint8Array(12).map((_, i) => 255 - i);
    const aad = Uint8Array.of(1, 2, 3);
    const text = "здравей, свят";
    const pt = new TextEncoder().encode(text);
    for (const suite of ["aes-256-gcm", "chacha20-poly1305"] as const) {
      const ct = await aeadSeal(suite, key, iv, aad, pt);
      expect(ct.length).toBe(pt.length + 16);
      // Compare decoded text: byte arrays from different realms do not compare equal in jsdom.
      expect(new TextDecoder().decode(await aeadOpen(suite, key, iv, aad, ct))).toBe(text);
    }
  });

  it("wire tags map back to their suites and unknown tags are refused", () => {
    expect(suiteFromWireTag(suiteWireTag("chacha20-poly1305"))).toBe("chacha20-poly1305");
    expect(suiteFromWireTag(suiteWireTag("aes-256-gcm"))).toBe("aes-256-gcm");
    expect(suiteFromWireTag("x")).toBeNull();
    expect(suiteFromWireTag(undefined)).toBeNull();
  });

  it("switching the sending suite keeps the conversation readable both ways", async () => {
    const { initiator, responder } = pair();
    expect(initiator.activeSuite).toBe("aes-256-gcm");
    expect(await responder.open(await initiator.seal("по старому"))).toBe("по старому");

    initiator.setSendSuite("chacha20-poly1305");
    const wire = await initiator.seal("по новому");
    expect((JSON.parse(wire) as { s: string }).s).toBe("c");
    expect(await responder.open(wire)).toBe("по новому");

    responder.setSendSuite("chacha20-poly1305");
    expect(await initiator.open(await responder.seal("отговор"))).toBe("отговор");
  });

  it("messages sent before a switch still open after it (in flight)", async () => {
    const { initiator, responder } = pair();
    const first = await initiator.seal("първо");
    initiator.setSendSuite("chacha20-poly1305");
    const second = await initiator.seal("второ");
    // Delivered out of order: the newer suite's message arrives first.
    expect(await responder.open(second)).toBe("второ");
    expect(await responder.open(first)).toBe("първо");
  });

  it("a message relabelled with the other suite tag fails authentication", async () => {
    const { initiator, responder } = pair();
    const wire = JSON.parse(await initiator.seal("тайно")) as Record<string, unknown>;
    wire.s = "c";
    await expect(responder.open(JSON.stringify(wire))).rejects.toThrow("Message failed authentication.");
  });

  it("messages without an s field (the earlier format) are read as AES-GCM", async () => {
    const { initiator, responder } = pair();
    const wire = JSON.parse(await initiator.seal("стар формат")) as Record<string, unknown>;
    delete wire.s;
    expect(await responder.open(JSON.stringify(wire))).toBe("стар формат");
  });

  it("an unknown suite tag is refused as malformed", async () => {
    const { initiator, responder } = pair();
    const wire = JSON.parse(await initiator.seal("x")) as Record<string, unknown>;
    wire.s = "rot13";
    await expect(responder.open(JSON.stringify(wire))).rejects.toThrow("Malformed message.");
  });
});
