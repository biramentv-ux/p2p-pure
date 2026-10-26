import { describe, it, expect } from "vitest";
import { WebSocketSignalingProvider, SignalingError } from "../../src/signaling/websocketProvider";
import type { SignalingPayload } from "../../src/signaling/types";

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

/** A socket the test drives: it can open, receive frames, and close. */
class FakeSocket {
  readyState = 0;
  url = "";
  peer: FakeSocket | null = null;
  readonly sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, event: Parameters<Listener>[0] = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  send(text: string): void {
    this.sent.push(text);
    // The Worker forwards the frame to the other end of the room.
    this.peer?.emit("message", { data: text });
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
    this.peer?.emit("close", { code, reason });
  }
}

/** A stand-in for the Worker: the first socket for a room is the offerer, the second joins it. */
function fakeWorker() {
  const sockets: FakeSocket[] = [];
  const makeSocket = (url: string): WebSocket => {
    const socket = new FakeSocket();
    socket.url = url;
    const first = sockets.find((s) => s.url === url && !s.peer);
    if (first) {
      first.peer = socket;
      socket.peer = first;
    }
    sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket as unknown as WebSocket;
  };
  return { makeSocket, sockets };
}

function okFetch(code: string) {
  return async () => new Response(JSON.stringify({ code }), { status: 201 });
}

const offer: SignalingPayload = { type: "offer", sdp: "v=0", did: "did:key:z6MkA", nonce: "aa", invitation: "p2p1:x" };
const answer: SignalingPayload = { type: "answer", sdp: "v=0", did: "did:key:z6MkB", nonce: "aa", invitation: "p2p1:y" };

describe("WebSocketSignalingProvider", () => {
  it("opens a room, joins it, and carries an offer and an answer both ways", async () => {
    const worker = fakeWorker();
    const host = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch("ABCDEFGHJK"));
    const guest = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch(""));
    const gotOffer: SignalingPayload[] = [];
    const gotAnswer: SignalingPayload[] = [];
    guest.onOfferReceived((p) => gotOffer.push(p));
    host.onAnswerReceived((p) => gotAnswer.push(p));

    const code = await host.openRoom();
    expect(code).toBe("ABCDEFGHJK");
    await guest.joinRoom(code);
    await host.sendOffer(offer);
    await guest.sendAnswer(answer);
    expect(gotOffer).toEqual([offer]);
    expect(gotAnswer).toEqual([answer]);
  });

  it("refuses to send the wrong kind of payload for the call", async () => {
    const worker = fakeWorker();
    const host = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch("ABCDEFGHJK"));
    await host.openRoom();
    await expect(host.sendAnswer(offer)).rejects.toThrow("Очаква се отговор");
  });

  it("drops frames that are not signaling payloads", async () => {
    const worker = fakeWorker();
    const host = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch("ABCDEFGHJK"));
    const got: SignalingPayload[] = [];
    host.onOfferReceived((p) => got.push(p));
    await host.openRoom();
    const hostSocket = worker.sockets[0];
    hostSocket.emit("message", { data: "not json" });
    hostSocket.emit("message", { data: JSON.stringify({ type: "offer", sdp: 3 }) });
    expect(got).toEqual([]);
  });

  it("reports a full room when the Worker refuses the join", async () => {
    const provider = new WebSocketSignalingProvider(
      "https://sig.example",
      () => {
        const socket = new FakeSocket();
        queueMicrotask(() => socket.close(1013, "room full"));
        return socket as unknown as WebSocket;
      },
      okFetch(""),
    );
    await expect(provider.joinRoom("ABCDEFGHJK")).rejects.toMatchObject({ code: "room_full" });
  });

  it("reports a network failure when the room cannot be opened", async () => {
    const provider = new WebSocketSignalingProvider("https://sig.example", fakeWorker().makeSocket, async () => {
      throw new TypeError("offline");
    });
    const err = await provider.openRoom().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignalingError);
    expect((err as SignalingError).code).toBe("network");
  });

  it("sending before a room is opened is refused", async () => {
    const provider = new WebSocketSignalingProvider("https://sig.example", fakeWorker().makeSocket, okFetch(""));
    await expect(provider.sendOffer(offer)).rejects.toThrow("Няма отворена стая");
  });

  it("disconnect closes the socket and removes handlers", async () => {
    const worker = fakeWorker();
    const host = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch("ABCDEFGHJK"));
    const got: SignalingPayload[] = [];
    host.onAnswerReceived((p) => got.push(p));
    await host.openRoom();
    host.disconnect();
    expect(worker.sockets[0].readyState).toBe(3);
    expect(got).toEqual([]);
  });

  it("waitForPeer resolves when the second device joins, and sends the offer after that", async () => {
    const worker = fakeWorker();
    const host = new WebSocketSignalingProvider("https://sig.example", worker.makeSocket, okFetch("ABCDEFGHJK"));
    await host.openRoom();
    const waiting = host.waitForPeer();
    worker.sockets[0].emit("message", { data: '{"type":"joined"}' });
    await expect(waiting).resolves.toBeUndefined();
    await expect(host.waitForPeer()).resolves.toBeUndefined();
  });
});
