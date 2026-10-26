import { describe, it, expect } from "vitest";
import { RoomRelay, MAX_RELAY_CHARS, type RoomPeer } from "../../worker/room";

function peer(name: string, log: string[]): RoomPeer & { closed?: string } {
  const p: RoomPeer & { closed?: string } = {
    send: (text) => log.push(`${name}<-${text}`),
    close: (code, reason) => {
      p.closed = `${code}:${reason}`;
    },
  };
  return p;
}

describe("RoomRelay", () => {
  it("forwards a frame to the other peer only", () => {
    const log: string[] = [];
    const relay = new RoomRelay();
    const a = peer("a", log);
    const b = peer("b", log);
    relay.join(a);
    relay.join(b);
    expect(relay.relay(a, "offer-json")).toBe(true);
    expect(log).toEqual(["b<-offer-json"]);
  });

  it("refuses a third peer", () => {
    const relay = new RoomRelay();
    const log: string[] = [];
    relay.join(peer("a", log));
    relay.join(peer("b", log));
    expect(relay.join(peer("c", log))).toBe(false);
    expect(relay.size).toBe(2);
  });

  it("drops oversized frames and frames sent before the second peer joins", () => {
    const log: string[] = [];
    const relay = new RoomRelay();
    const a = peer("a", log);
    relay.join(a);
    expect(relay.relay(a, "alone")).toBe(false);
    relay.join(peer("b", log));
    expect(relay.relay(a, "x".repeat(MAX_RELAY_CHARS + 1))).toBe(false);
    expect(log).toEqual([]);
  });

  it("closes the other peer when one leaves", () => {
    const log: string[] = [];
    const relay = new RoomRelay();
    const a = peer("a", log);
    const b = peer("b", log);
    relay.join(a);
    relay.join(b);
    relay.leave(a);
    expect(b.closed).toBe("1000:peer left");
    expect(relay.size).toBe(0);
  });

  it("closeAll closes every peer with the reason given", () => {
    const log: string[] = [];
    const relay = new RoomRelay();
    const a = peer("a", log);
    relay.join(a);
    relay.closeAll("room expired");
    expect(a.closed).toBe("1000:room expired");
  });
});
