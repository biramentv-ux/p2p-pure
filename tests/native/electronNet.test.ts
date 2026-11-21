// @vitest-environment node
/**
 * П4: the Electron shell's native half (electron/nativeNet.mjs) and the whole native path on
 * one machine: two bridges, a local STUN server, endpoint gathering, punching and the encrypted
 * link. (Across real NATs the same code runs in the lab: scripts/natlab/native.mjs.)
 */
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { allowedLanUrl, createNativeNet, lanAddress } from "../../electron/nativeNet.mjs";
// @ts-expect-error plain .mjs without types
import { startStun } from "../../scripts/natlab/stun.mjs";
import type { NativeBridge } from "../../src/native/bridge";
import { connectNative, gatherNativeEndpoint, punchInParallel, stunTargets } from "../../src/native/nativeConnect";
import { addNativeLine, nativeSecret, readNativeLine, stripNativeLines } from "../../src/native/endpoint";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";

function nodeBridge(): NativeBridge & { closeAll(): void } {
  const handlers = new Set<(id: number, b: Uint8Array, host: string, port: number) => void>();
  const net = createNativeNet((id: number, b: Uint8Array, host: string, port: number) => handlers.forEach((h) => h(id, b, host, port)));
  return {
    kind: "electron",
    udpOpen: () => net.open(),
    udpSend: (id, host, port, bytes, ttl) => net.send(id, host, port, bytes, ttl),
    udpClose: (id) => net.close(id),
    onUdp: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    ssdp: (t) => net.ssdp(t),
    lanHttp: (url, init) => net.lanHttp(url, init),
    closeAll: () => net.closeAll(),
  };
}

const stun1 = startStun({ host: "127.0.0.1", port: 34781 });
const stun2 = startStun({ host: "127.0.0.1", port: 34782 });
afterAll(() => {
  stun1.close();
  stun2.close();
});

describe("П4 Electron shell: native half", () => {
  it("sends only http to a private LAN address", async () => {
    expect(allowedLanUrl("http://192.168.1.1:5000/x")?.hostname).toBe("192.168.1.1");
    for (const u of ["https://192.168.1.1/", "http://8.8.8.8/", "http://localhost/", "file:///etc/passwd", "nonsense"]) expect(allowedLanUrl(u)).toBeNull();
    const net = createNativeNet(() => undefined);
    await expect(net.lanHttp("http://93.184.216.34/")).rejects.toThrow(/LAN/);
    expect(lanAddress({ eth0: [{ family: "IPv4", internal: false, address: "192.168.0.7" }] })).toBe("192.168.0.7");
    expect(lanAddress({ eth0: [{ family: "IPv4", internal: false, address: "8.8.8.8" }] })).toBeUndefined();
  });

  it("moves datagrams between two sockets and ignores bad sends", async () => {
    const got: Array<[number, string]> = [];
    const net = createNativeNet((id: number, b: Uint8Array) => got.push([id, new TextDecoder().decode(b)]));
    const a = await net.open();
    const b = await net.open();
    net.send(a.id, "127.0.0.1", b.port, new TextEncoder().encode("hello"), 3);
    net.send(a.id, "127.0.0.1", 0, new TextEncoder().encode("bad port"));
    net.send(a.id, "127.0.0.1", b.port, new Uint8Array(5000)); // too large
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([[b.id, "hello"]]);
    net.closeAll();
  });
});

describe("П4 native path end to end on one machine", () => {
  it("SDP line round trip; the key is the same on both sides", () => {
    const sdp = "v=0\r\na=mid:0\r\n";
    const withLine = addNativeLine(sdp, { host: "203.0.113.5", port: 40000, nat: "symmetric" });
    expect(readNativeLine(withLine)).toEqual({ host: "203.0.113.5", port: 40000, nat: "symmetric" });
    expect(stripNativeLines(withLine)).toBe(sdp);
    expect(readNativeLine("a=x-p2p-native:1 999.1.1.1 1 cone\r\n")).toBeNull();
    expect(() => addNativeLine(sdp, { host: "example.com", port: 1, nat: "cone" })).toThrow();
    const a = createEphemeralKeyPair();
    const b = createEphemeralKeyPair();
    const nonce = new Uint8Array(16).fill(4);
    expect(nativeSecret(a.secretKey, b.publicKey, nonce)).toEqual(nativeSecret(b.secretKey, a.publicKey, nonce));
    expect(stunTargets(["stun:stun.l.google.com:19302", "stun:[2001:db8::1]:3478", "turn:x"])).toEqual([{ host: "stun.l.google.com", port: 19302 }]);
    expect(punchInParallel("cone", "symmetric")).toBe(true);
    expect(punchInParallel("cone", "cone")).toBe(false);
  });

  it("gathers both endpoints by STUN, punches and carries messages over the encrypted link", async () => {
    const ba = nodeBridge();
    const bb = nodeBridge();
    const stun = ["stun:127.0.0.1:34781", "stun:127.0.0.1:34782"];
    const [ga, gb] = await Promise.all([gatherNativeEndpoint(ba, stun, { portMapping: false }), gatherNativeEndpoint(bb, stun, { portMapping: false })]);
    expect(ga?.endpoint.nat).toBe("cone");
    expect(gb?.endpoint.nat).toBe("cone");
    const secret = new Uint8Array(32).fill(7);
    const [la, lb] = await Promise.all([
      connectNative({ bridge: ba, socket: ga!.socket, side: "A", secret, me: "cone", peer: gb!.endpoint, timeoutMs: 10_000 }),
      connectNative({ bridge: bb, socket: gb!.socket, side: "B", secret, me: "cone", peer: ga!.endpoint, timeoutMs: 10_000 }),
    ]);
    const got: string[] = [];
    const done = new Promise<void>((resolve) => lb.onMessage((t) => (got.push(t), got.length === 50 && resolve())));
    for (let i = 0; i < 50; i++) la.send(`m${i}`);
    const big = Uint8Array.from({ length: 200_000 }, (_, i) => i & 0xff);
    const bin = new Promise<Uint8Array>((resolve) => la.onBinary(resolve));
    await lb.sendBinary(big);
    await done;
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    expect(await bin).toEqual(big);
    la.close();
    lb.close();
    ba.closeAll();
    bb.closeAll();
  }, 30_000);
});
