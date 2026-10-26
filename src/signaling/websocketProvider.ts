/**
 * Demo signaling over the signaling Worker's WebSocket room (worker/room.ts).
 *
 * The offering device opens a room and shares its code out of band; the answering device
 * joins with that code. The Worker only forwards frames between the two; the signed
 * invitation inside each payload is what the peers verify. This mode is optional: the
 * core app works without it, through the offline provider.
 */
import { INVITE_API_BASE, type FetchLike } from "../p2p/shortInvite";
import { isSignalingPayload, type ISignalingProvider, type PayloadHandler, type SignalingPayload } from "./types";

export type SignalingErrorCode = "network" | "room_full" | "not_found" | "closed" | "not_open";

export class SignalingError extends Error {
  readonly code: SignalingErrorCode;
  constructor(message: string, code: SignalingErrorCode) {
    super(message);
    this.name = "SignalingError";
    this.code = code;
  }
}

export type SocketFactory = (url: string) => WebSocket;

const defaultSocket: SocketFactory = (url) => new WebSocket(url);
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function wsUrl(apiBase: string, code: string): string {
  const url = new URL(`/ws/rooms/${encodeURIComponent(code)}`, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class WebSocketSignalingProvider implements ISignalingProvider {
  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private offerHandlers: PayloadHandler[] = [];
  private answerHandlers: PayloadHandler[] = [];
  private readonly apiBase: string;
  private readonly makeSocket: SocketFactory;
  private readonly fetchImpl: FetchLike;

  constructor(apiBase: string = INVITE_API_BASE, makeSocket: SocketFactory = defaultSocket, fetchImpl: FetchLike = defaultFetch) {
    this.apiBase = apiBase;
    this.makeSocket = makeSocket;
    this.fetchImpl = fetchImpl;
  }

  async init(): Promise<void> {
    // Nothing to set up until a room is opened or joined.
  }

  /** Offering device: opens a room and returns the code to share. */
  async openRoom(): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/ws/rooms`, { method: "POST" });
    } catch {
      throw new SignalingError("Няма връзка със сигналния сървър.", "network");
    }
    if (res.status === 429) throw new SignalingError("Твърде много опити. Опитайте след малко.", "network");
    if (!res.ok) throw new SignalingError("Стаята не можа да се отвори.", "network");
    const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
    if (!data || typeof data.code !== "string") throw new SignalingError("Невалиден отговор.", "network");
    await this.connect(data.code);
    return data.code;
  }

  /** Answering device: joins the room whose code it received. */
  async joinRoom(code: string): Promise<void> {
    await this.connect(code);
  }

  async sendOffer(payload: SignalingPayload): Promise<void> {
    if (payload.type !== "offer") throw new SignalingError("Очаква се покана.", "not_open");
    await this.send(payload);
  }

  async sendAnswer(payload: SignalingPayload): Promise<void> {
    if (payload.type !== "answer") throw new SignalingError("Очаква се отговор.", "not_open");
    await this.send(payload);
  }

  onOfferReceived(callback: PayloadHandler): void {
    this.offerHandlers.push(callback);
  }

  onAnswerReceived(callback: PayloadHandler): void {
    this.answerHandlers.push(callback);
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.opened = null;
    this.offerHandlers = [];
    this.answerHandlers = [];
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, "done");
  }

  private connect(code: string): Promise<void> {
    if (this.socket) this.disconnect();
    const socket = this.makeSocket(wsUrl(this.apiBase, code));
    this.socket = socket;
    this.opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new SignalingError("Връзката към стаята се провали.", "network")));
      socket.addEventListener("close", (event) => {
        if (this.socket === socket) this.socket = null;
        const reason = event.reason === "room full" || event.code === 1013 ? "room_full" : "closed";
        reject(
          reason === "room_full"
            ? new SignalingError("Стаята вече има двама участници.", "room_full")
            : new SignalingError("Стаята е затворена.", "closed"),
        );
      });
    });
    // A rejection from a socket that was never awaited must not surface as unhandled.
    this.opened.catch(() => undefined);
    socket.addEventListener("message", (event) => this.onFrame(event.data));
    return this.opened;
  }

  private async send(payload: SignalingPayload): Promise<void> {
    if (!this.opened) throw new SignalingError("Няма отворена стая.", "not_open");
    await this.opened;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new SignalingError("Стаята е затворена.", "closed");
    }
    this.socket.send(JSON.stringify(payload));
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isSignalingPayload(parsed)) return;
    const handlers = parsed.type === "offer" ? this.offerHandlers : this.answerHandlers;
    for (const handler of handlers) handler(parsed);
  }
}
