import { describe, expect, it, vi } from "vitest";
import { armNativeLink, prepareNative, withNative, type NativePrep } from "../../src/native/nativePairing";
import { setNativeTransportEnabled } from "../../src/native/nativeConnect";
import { readNativeLine } from "../../src/native/endpoint";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";
import type { NativeArm, PeerLink } from "../../src/p2p/peer";

function fakePrep(nat: "cone" | "symmetric"): NativePrep & { closed: () => boolean } {
  let closed = false;
  return {
    bridge: {} as NativePrep["bridge"],
    endpoint: { host: "198.51.100.10", port: 40000, nat },
    socket: { localPort: 1, send: () => undefined, onMessage: () => () => undefined, close: () => (closed = true) },
    closed: () => closed,
  };
}

const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";

describe("П4 connect-screen glue", () => {
  it("does nothing in a browser, even with the setting on", async () => {
    setNativeTransportEnabled(true);
    expect(await prepareNative()).toBeNull();
    setNativeTransportEnabled(false);
    expect(await prepareNative()).toBeNull();
  });

  it("adds our endpoint line only when there is one", () => {
    expect(withNative(SDP, null)).toBe(SDP);
    const prep = fakePrep("cone");
    expect(readNativeLine(withNative(SDP, prep))).toEqual(prep.endpoint);
  });

  it("closes the socket when the peer's invitation has no endpoint", () => {
    const prep = fakePrep("cone");
    const link = { armNative: vi.fn() } as unknown as PeerLink;
    const a = createEphemeralKeyPair();
    const b = createEphemeralKeyPair();
    const armed = armNativeLink(link, prep, { side: "A", peerSdp: SDP, myEphemeralSecret: a.secretKey, peerEphemeralPublic: b.publicKey, offerNonce: new Uint8Array(16) });
    expect(armed).toBe(false);
    expect(prep.closed()).toBe(true);
    expect(link.armNative).not.toHaveBeenCalled();
  });

  it("arms in parallel only when WebRTC is expected to fail (cone against symmetric)", () => {
    const a = createEphemeralKeyPair();
    const b = createEphemeralKeyPair();
    const arms: NativeArm[] = [];
    const link = { armNative: (arm: NativeArm) => arms.push(arm) } as unknown as PeerLink;
    const args = (peer: NativePrep) => ({ side: "B" as const, peerSdp: withNative(SDP, peer), myEphemeralSecret: a.secretKey, peerEphemeralPublic: b.publicKey, offerNonce: new Uint8Array(16) });
    expect(armNativeLink(link, fakePrep("cone"), args(fakePrep("symmetric")))).toBe(true);
    expect(armNativeLink(link, fakePrep("cone"), args(fakePrep("cone")))).toBe(true);
    expect(arms.map((x) => x.parallel)).toEqual([true, false]);
    const prep = fakePrep("cone");
    armNativeLink(link, prep, args(fakePrep("cone")));
    arms[2].cancel();
    expect(prep.closed()).toBe(true);
    return expect(arms[2].start()).rejects.toThrow("cancelled");
  });
});
