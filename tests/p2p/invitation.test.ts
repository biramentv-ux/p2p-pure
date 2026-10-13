import { describe, it, expect } from "vitest";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import {
  createInvitation,
  encodeInvitation,
  decodeInvitation,
  InvitationError,
  INVITATION_TTL_MS,
  INVITATION_PREFIX,
} from "../../src/p2p/invitation";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const ephA = createEphemeralKeyPair().publicKey;
const ephB = createEphemeralKeyPair().publicKey;

// Realistic-sized SDP: header lines plus ~8 ICE candidates and a DTLS fingerprint.
function fakeSdp(candidates = 8): string {
  const lines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:Xk3p",
    "a=ice-pwd:Qw8rTzLpMnBvCxZaSdFgHjKl",
    "a=ice-options:trickle",
    "a=fingerprint:sha-256 " +
      Array.from({ length: 32 }, (_, i) => ((i * 7) % 256).toString(16).padStart(2, "0").toUpperCase()).join(":"),
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];
  for (let i = 0; i < candidates; i++) {
    lines.push(
      `a=candidate:${1000 + i} 1 udp ${2122260223 - i} 192.168.1.${10 + i} ${50000 + i} typ host generation 0 network-cost 999`,
    );
  }
  return lines.join("\r\n") + "\r\n";
}

describe("invitation codec", () => {
  it("round-trips an offer, including the ephemeral key", async () => {
    const sdp = fakeSdp();
    const inv = createInvitation("offer", sdp, alice, ephA);
    const decoded = await decodeInvitation(await encodeInvitation(inv));

    expect(decoded.kind).toBe("offer");
    expect(decoded.sdp).toBe(sdp);
    expect(decoded.publicKey).toEqual(alice.publicKey);
    expect(decoded.ephemeralPublicKey).toEqual(ephA);
    expect(decoded.nonce).toEqual(inv.nonce);
    expect(decoded.expiresAt).toBe(inv.expiresAt);
    expect(decoded.answersNonce).toBeUndefined();
  });

  it("round-trips an answer that references the offer nonce", async () => {
    const offer = createInvitation("offer", fakeSdp(), alice, ephA);
    const answer = createInvitation("answer", fakeSdp(3), bob, ephB, {
      answersNonce: offer.nonce,
    });
    const payload = await encodeInvitation(answer);
    expect(payload.startsWith(INVITATION_PREFIX)).toBe(true);
    const decoded = await decodeInvitation(payload);

    expect(decoded.kind).toBe("answer");
    expect(decoded.publicKey).toEqual(bob.publicKey);
    expect(decoded.ephemeralPublicKey).toEqual(ephB);
    expect(decoded.answersNonce).toEqual(offer.nonce);
  });

  it("fits a realistic offer comfortably inside one QR code", async () => {
    const payload = await encodeInvitation(createInvitation("offer", fakeSdp(8), alice, ephA));
    // QR byte capacity at error level M is 2331 bytes; keep a wide margin.
    expect(payload.length).toBeLessThan(1500);
  });

  it("rejects a tampered SDP (signature no longer matches)", async () => {
    const payload = await encodeInvitation(createInvitation("offer", fakeSdp(), alice, ephA));
    const i = Math.floor(payload.length / 2);
    const flipped = payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1);
    await expect(decodeInvitation(flipped)).rejects.toBeInstanceOf(InvitationError);
  });

  it("rejects a swapped ephemeral key (session keys would be bound to the wrong key)", async () => {
    const real = createInvitation("offer", fakeSdp(), alice, ephA);
    const swapped = { ...real, ephemeralPublicKey: ephB };
    await expect(decodeInvitation(await encodeInvitation(swapped))).rejects.toMatchObject({
      code: "BAD_SIGNATURE",
    });
  });

  it("rejects a forged sender key (signature was made by someone else)", async () => {
    const real = createInvitation("offer", fakeSdp(), alice, ephA);
    const forged = { ...real, publicKey: bob.publicKey };
    await expect(decodeInvitation(await encodeInvitation(forged))).rejects.toMatchObject({
      code: "BAD_SIGNATURE",
    });
  });

  it("rejects an expired invitation", async () => {
    const past = Date.now() - INVITATION_TTL_MS - 1_000;
    const payload = await encodeInvitation(createInvitation("offer", fakeSdp(), alice, ephA, { now: past }));
    await expect(decodeInvitation(payload)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  it("accepts an invitation just before expiry", async () => {
    const now = 1_700_000_000_000;
    const payload = await encodeInvitation(createInvitation("offer", fakeSdp(), alice, ephA, { now }));
    const decoded = await decodeInvitation(payload, now + INVITATION_TTL_MS - 1);
    expect(decoded.kind).toBe("offer");
  });

  it("rejects input without the p2p1 prefix", async () => {
    await expect(decodeInvitation("https://example.com")).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("rejects truncated input", async () => {
    const payload = await encodeInvitation(createInvitation("offer", fakeSdp(), alice, ephA));
    await expect(decodeInvitation(payload.slice(0, 40))).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("refuses to create an answer without answersNonce", () => {
    expect(() => createInvitation("answer", fakeSdp(), bob, ephB)).toThrow(InvitationError);
  });

  it("refuses an answersNonce of the wrong length", () => {
    expect(() =>
      createInvitation("answer", fakeSdp(), bob, ephB, { answersNonce: new Uint8Array(8) }),
    ).toThrow(InvitationError);
  });

  it("refuses an ephemeral key of the wrong length", () => {
    expect(() => createInvitation("offer", fakeSdp(), alice, new Uint8Array(31))).toThrow(InvitationError);
  });
});
