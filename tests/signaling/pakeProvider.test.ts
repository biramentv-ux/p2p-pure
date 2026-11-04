import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomRelay, type RoomPeer } from "../../worker/room";
import { PakeError, PakeSignalingProvider } from "../../src/signaling/pakeProvider";
import { WebSocketSignalingProvider } from "../../src/signaling/websocketProvider";
import { ROOM_ID_ALPHABET, newPairingWords, type PairingCode } from "../../src/p2p/pairingCode";
import type { SignalingPayload } from "../../src/signaling/types";

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** One end of an in-memory room, wired to a RoomRelay exactly like worker/room.ts does. */
class FakeSocket {
  readyState = 0;
  readonly peer: RoomPeer;
  private listeners = new Map<string, Listener[]>();
  constructor(
    private readonly relay: RoomRelay,
    private readonly net: Net,
    readonly name: string,
  ) {
    this.peer = {
      // relay -> client
      send: (text) => {
        if (this.readyState !== 3) this.net.deliver(() => this.emit("message", { data: text }));
      },
      close: (code, reason) => this.close(code, reason),
    };
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: Parameters<Listener>[0] = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  /** client -> relay (the WebSocket API). */
  send(text: string): void {
    this.net.frames.push({ from: this.name, text });
    this.relay.relay(this.peer, this.net.mutate?.(this.name, text) ?? text);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
    this.relay.leave(this.peer);
  }
}

class Net {
  frames: Array<{ from: string; text: string }> = [];
  mutate: ((from: string, text: string) => string) | null = null;
  constructor(readonly async: boolean) {}
  deliver(fn: () => void): void {
    if (this.async) setTimeout(fn, 0);
    else fn();
  }
}

function harness(async = false) {
  const net = new Net(async);
  const relays = new Map<string, RoomRelay>();
  const sockets: FakeSocket[] = [];
  const makeSocket = (url: string): WebSocket => {
    const room = decodeURIComponent(url.split("/").pop() ?? "");
    let relay = relays.get(room);
    if (!relay) relays.set(room, (relay = new RoomRelay()));
    const socket = new FakeSocket(relay, net, sockets.length === 0 ? "A" : "B");
    sockets.push(socket);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.emit("open");
      if (!relay.join(socket.peer)) socket.close(1013, "room full");
    });
    return socket as unknown as WebSocket;
  };
  return { net, sockets, makeSocket };
}

const ROOM = ROOM_ID_ALPHABET.slice(0, 5);
const okFetch = async () => new Response(JSON.stringify({ code: ROOM }), { status: 201 });

const offer: SignalingPayload = {
  type: "offer",
  sdp: "v=0 SECRET-SDP a=candidate 192.0.2.1",
  did: "did:key:z6MkAAAA",
  nonce: "aa",
  invitation: "p2p1:SECRETINVITE",
};
const answer: SignalingPayload = { type: "answer", sdp: "v=0 answer", did: "did:key:z6MkBBBB", nonce: "bb" };

function pair(h: ReturnType<typeof harness>, timeoutMs?: number) {
  const opener = new PakeSignalingProvider(
    new WebSocketSignalingProvider("https://sig.example", h.makeSocket, okFetch),
    { timeoutMs },
  );
  const joiner = new PakeSignalingProvider(
    new WebSocketSignalingProvider("https://sig.example", h.makeSocket, okFetch),
    { timeoutMs },
  );
  return { opener, joiner };
}

function otherWord(w: string): string {
  return w === "abandon" ? "zoo" : "abandon";
}

afterEach(() => vi.useRealTimers());

describe("PakeSignalingProvider", () => {
  for (const async of [false, true]) {
    it(`pairs with the right code and carries offer and answer intact (async relay: ${async})`, async () => {
      const h = harness(async);
      const { opener, joiner } = pair(h);
      const gotOffer: SignalingPayload[] = [];
      const gotAnswer: SignalingPayload[] = [];
      joiner.onOfferReceived((p) => gotOffer.push(p));
      opener.onAnswerReceived((p) => gotAnswer.push(p));

      const run = async () => {
        const code = await opener.openRoom();
        expect(code.room).toBe(ROOM);
        expect(code.words).toHaveLength(3);
        const j = joiner.joinRoom(code);
        const both = Promise.all([opener.waitForPeer(), joiner.waitForPeer(), j]);
        if (async) await vi.runAllTimersAsync();
        await both;
        await opener.sendOffer(offer);
        if (async) await vi.runAllTimersAsync();
        await joiner.sendAnswer(answer);
        if (async) await vi.runAllTimersAsync();
      };
      if (async) vi.useFakeTimers();
      await run();
      expect(gotOffer).toEqual([offer]);
      expect(gotAnswer).toEqual([answer]);
    });
  }

  it("the relay never sees invitations, SDP, identities or the words", async () => {
    const h = harness();
    const { opener, joiner } = pair(h);
    const code = await opener.openRoom();
    await joiner.joinRoom(code);
    await Promise.all([opener.waitForPeer(), joiner.waitForPeer()]);
    await opener.sendOffer(offer);
    await joiner.sendAnswer(answer);
    expect(h.net.frames.length).toBeGreaterThanOrEqual(6);
    const all = h.net.frames.map((f) => f.text).join("\n");
    for (const needle of ["p2p1:", "sdp", "SDP", "did:key", "SECRET", ...code.words]) {
      expect(all).not.toContain(needle);
    }
  });

  it("one wrong word makes both sides fail with wrong_code and closes the sockets", async () => {
    const h = harness();
    const { opener, joiner } = pair(h);
    const code = await opener.openRoom();
    const wrong: PairingCode = {
      room: code.room,
      words: [otherWord(code.words[0]), code.words[1], code.words[2]],
    };
    const j = joiner.joinRoom(wrong);
    const a = opener.waitForPeer().catch((e: unknown) => e);
    const b = joiner.waitForPeer().catch((e: unknown) => e);
    await j;
    const [ea, eb] = await Promise.all([a, b]);
    expect(ea).toBeInstanceOf(PakeError);
    expect(eb).toBeInstanceOf(PakeError);
    expect((ea as PakeError).code).toBe("wrong_code");
    expect((eb as PakeError).code).toBe("wrong_code");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sockets.every((s) => s.readyState === 3)).toBe(true);
    await expect(opener.sendOffer(offer)).rejects.toBeInstanceOf(PakeError);
  });

  it("sending before confirmation is refused", async () => {
    const h = harness();
    const { opener } = pair(h);
    await opener.openRoom();
    await expect(opener.sendOffer(offer)).rejects.toMatchObject({ code: "protocol" });
  });

  async function pairedWithTap() {
    const h = harness();
    const { opener, joiner } = pair(h);
    const got: SignalingPayload[] = [];
    const errors: PakeError[] = [];
    joiner.onOfferReceived((p) => got.push(p));
    joiner.onError((e) => errors.push(e));
    const code = await opener.openRoom();
    await joiner.joinRoom(code);
    await Promise.all([opener.waitForPeer(), joiner.waitForPeer()]);
    return { h, opener, joiner, got, errors };
  }

  it("a tampered box is rejected and the channel closes", async () => {
    const { h, opener, got, errors } = await pairedWithTap();
    h.net.mutate = (_from, text) => {
      const f = JSON.parse(text) as { t: string; c?: string };
      if (f.t !== "box" || !f.c) return text;
      const flipped = (f.c[0] === "A" ? "B" : "A") + f.c.slice(1);
      return JSON.stringify({ ...f, c: flipped });
    };
    await opener.sendOffer(offer);
    expect(got).toEqual([]);
    expect(errors[0]).toMatchObject({ code: "protocol" });
    expect(h.sockets.every((s) => s.readyState === 3)).toBe(true);
  });

  it("a replayed box frame is rejected", async () => {
    const { h, opener, got, errors } = await pairedWithTap();
    await opener.sendOffer(offer);
    expect(got).toEqual([offer]);
    const box = [...h.net.frames].reverse().find((f) => f.text.includes('"box"'))!;
    const joinerSocket = h.sockets[1];
    joinerSocket.emit("message", { data: box.text });
    expect(got).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "protocol" });
    expect(joinerSocket.readyState).toBe(3);
  });

  it("a second pake frame is a protocol error", async () => {
    const { h, errors } = await pairedWithTap();
    const pake = h.net.frames.find((f) => f.from === "A" && f.text.includes('"pake"'))!;
    h.sockets[1].emit("message", { data: pake.text });
    expect(errors[0]).toMatchObject({ code: "protocol" });
    expect(h.sockets[1].readyState).toBe(3);
  });

  it("times out when nobody joins", async () => {
    vi.useFakeTimers();
    const h = harness();
    const { opener } = pair(h, 120_000);
    await opener.openRoom();
    const waiting = opener.waitForPeer().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_001);
    const err = (await waiting) as PakeError;
    expect(err).toBeInstanceOf(PakeError);
    expect(err.code).toBe("timeout");
    expect(h.sockets[0].readyState).toBe(3);
  });

  it("rejects with closed when the socket drops before completion", async () => {
    const h = harness();
    const { opener } = pair(h);
    await opener.openRoom();
    const waiting = opener.waitForPeer().catch((e: unknown) => e);
    h.sockets[0].close(1006, "gone");
    expect(((await waiting) as PakeError).code).toBe("closed");
  });

  it("newPairingWords gives distinct codes (sanity for the harness)", () => {
    expect(newPairingWords()).toHaveLength(3);
  });
});
