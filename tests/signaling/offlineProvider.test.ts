import { describe, it, expect, vi } from "vitest";
import { OfflineSignalingProvider } from "../../src/signaling/offlineProvider";
import type { SignalingPayload } from "../../src/signaling/types";

const offer: SignalingPayload = { type: "offer", sdp: "v=0", did: "did:key:z6MkTest", nonce: "abcd" };
const answer: SignalingPayload = { type: "answer", sdp: "v=0", did: "did:key:z6MkPeer", nonce: "abcd" };

describe("OfflineSignalingProvider", () => {
  it("hands a locally generated payload to the UI and does not touch the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new OfflineSignalingProvider();
    const seen = vi.fn();
    provider.onLocalPayloadGenerated(seen);
    await provider.sendOffer(offer);
    await provider.sendAnswer(answer);
    expect(seen.mock.calls.map((c) => c[0])).toEqual([offer, answer]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("routes a scanned offer and answer to the matching handler", () => {
    const provider = new OfflineSignalingProvider();
    const onOffer = vi.fn();
    const onAnswer = vi.fn();
    provider.onOfferReceived(onOffer);
    provider.onAnswerReceived(onAnswer);
    provider.acceptRemotePayload(offer);
    provider.acceptRemotePayload(answer);
    expect(onOffer).toHaveBeenCalledWith(offer);
    expect(onAnswer).toHaveBeenCalledWith(answer);
  });

  it("rejects a payload of the wrong shape before any handler runs", () => {
    const provider = new OfflineSignalingProvider();
    const onOffer = vi.fn();
    provider.onOfferReceived(onOffer);
    expect(() => provider.acceptRemotePayload({ type: "offer", sdp: 1 })).toThrow("Невалиден");
    expect(() => provider.acceptRemotePayload("p2p1:...")).toThrow("Невалиден");
    expect(onOffer).not.toHaveBeenCalled();
  });

  it("disconnect removes every handler", () => {
    const provider = new OfflineSignalingProvider();
    const onOffer = vi.fn();
    provider.onOfferReceived(onOffer);
    provider.disconnect();
    provider.acceptRemotePayload(offer);
    expect(onOffer).not.toHaveBeenCalled();
  });
});
