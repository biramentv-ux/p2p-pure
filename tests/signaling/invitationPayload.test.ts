import { describe, it, expect } from "vitest";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";
import { createInvitation, encodeInvitation, InvitationError } from "../../src/p2p/invitation";
import { OfflineSignalingProvider } from "../../src/signaling/offlineProvider";
import { parseScannedInvitation, toSignalingPayload } from "../../src/signaling/invitationPayload";

const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

async function offerString() {
  const keys = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  const eph = createEphemeralKeyPair();
  const offer = createInvitation("offer", SDP, keys, eph.publicKey);
  return { keys, offer, text: await encodeInvitation(offer) };
}

describe("invitation payloads", () => {
  it("wraps an offer with the sender's did, sdp and nonce, and keeps the signed string", async () => {
    const { keys, offer, text } = await offerString();
    const payload = toSignalingPayload(offer, text);
    expect(payload.type).toBe("offer");
    expect(payload.did).toBe(publicKeyToDidKey(keys.publicKey));
    expect(payload.sdp).toBe(SDP);
    expect(payload.nonce).toHaveLength(offer.nonce.length * 2);
    expect(payload.invitation).toBe(text);
  });

  it("a scanned invitation passes through the provider and comes back verified", async () => {
    const { text } = await offerString();
    const provider = new OfflineSignalingProvider();
    const received: string[] = [];
    provider.onOfferReceived((p) => received.push(p.invitation ?? ""));
    const { payload } = await parseScannedInvitation(text);
    provider.acceptRemotePayload(payload);
    expect(received).toEqual([text]);
  });

  it("a tampered invitation is rejected before it reaches the provider", async () => {
    const { text } = await offerString();
    const tampered = text.slice(0, -4) + (text.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(parseScannedInvitation(tampered)).rejects.toBeInstanceOf(InvitationError);
  });
});
