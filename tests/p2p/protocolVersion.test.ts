import { describe, expect, it } from "vitest";
import { CAPABILITIES, PROTOCOL_VERSION, hasCap, readPeerProtocol } from "../../src/p2p/protocol";
import { completeHandshake } from "../../src/p2p/session";
import { publicKeyToDidKey } from "../../src/identity/didKey";

describe("protocol version and capabilities in hello", () => {
  it("reads pv/caps and ignores unknown or malformed values", () => {
    expect(readPeerProtocol({ pv: 2, caps: ["resume", "timer", "x", 5, "resume"] })).toEqual({ pv: 2, caps: ["resume", "timer"] });
    expect(readPeerProtocol({})).toEqual({ pv: 1, caps: [] });
    expect(readPeerProtocol({ pv: -3, caps: "resume" })).toEqual({ pv: 1, caps: [] });
    expect(readPeerProtocol({ pv: 1.5 })).toEqual({ pv: 1, caps: [] });
    expect(hasCap({ pv: 2, caps: ["rv"] }, "rv")).toBe(true);
    expect(hasCap(null, "rv")).toBe(false);
  });

  function fakeLink() {
    const handlers = new Set<(t: string) => void>();
    const sent: string[] = [];
    const link = {
      peerProtocol: undefined as undefined | { pv: number; caps: string[] },
      onMessage: (h: (t: string) => void) => (handlers.add(h), () => handlers.delete(h)),
      waitForOpen: async () => undefined,
      send: (t: string) => void sent.push(t),
      deliver: (t: string) => [...handlers].forEach((h) => h(t)),
    };
    return { link, sent };
  }

  it("sends pv and caps, and a peer from before v2 still connects", async () => {
    const peerKey = new Uint8Array(32).fill(4);
    const peerDid = publicKeyToDidKey(peerKey);
    const { link, sent } = fakeLink();
    const done = completeHandshake(link as never, "did:me", peerKey);
    await Promise.resolve();
    link.deliver(JSON.stringify({ t: "hello", did: peerDid })); // old client: no pv, no caps
    await expect(done).resolves.toBe(peerDid);
    expect(link.peerProtocol).toEqual({ pv: 1, caps: [] });
    const mine = JSON.parse(sent[0]);
    expect(mine).toEqual({ t: "hello", did: "did:me", pv: PROTOCOL_VERSION, caps: [...CAPABILITIES] });
  });

  it("records a v2 peer's capabilities", async () => {
    const peerKey = new Uint8Array(32).fill(5);
    const peerDid = publicKeyToDidKey(peerKey);
    const { link } = fakeLink();
    const done = completeHandshake(link as never, "did:me", peerKey);
    await Promise.resolve();
    link.deliver(JSON.stringify({ t: "hello", did: peerDid, pv: 2, caps: ["resume", "rv"] }));
    await done;
    expect(link.peerProtocol).toEqual({ pv: 2, caps: ["resume", "rv"] });
  });
});
