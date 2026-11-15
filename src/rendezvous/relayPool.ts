/**
 * A few WebSocket connections to public Nostr relays (Н2). One subscription (the topics to
 * listen on) is kept on every relay and sent again after a reconnect; published events go to
 * every open relay. Events are deduplicated by id. The pool does not trust relays: it only
 * hands events on, and the rendezvous checks them.
 */
import { parseRelayMessage, verifyEvent, type NostrEvent, type NostrFilter } from "./nostr";
import { DEFAULT_RELAYS } from "./relays";

export { DEFAULT_RELAYS };


export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

const OPEN = 1;
const SUB_ID = "rv";
const MAX_SEEN = 2000;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

interface Conn {
  url: string;
  ws: SocketLike | null;
  tries: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class RelayPool {
  private readonly conns: Conn[];
  private readonly factory: SocketFactory;
  private filter: NostrFilter | null = null;
  private readonly seen = new Set<string>();
  private closed = false;
  private onEvent: (e: NostrEvent) => void = () => undefined;
  private onStatus: (open: number) => void = () => undefined;

  constructor(urls: string[] = DEFAULT_RELAYS, factory: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike) {
    this.factory = factory;
    this.conns = urls.map((url) => ({ url, ws: null, tries: 0, timer: undefined }));
    for (const c of this.conns) this.connect(c);
  }

  /** How many relays are open now. */
  get openCount(): number {
    return this.conns.filter((c) => c.ws?.readyState === OPEN).length;
  }

  listen(onEvent: (e: NostrEvent) => void, onStatus?: (open: number) => void): void {
    this.onEvent = onEvent;
    if (onStatus) this.onStatus = onStatus;
  }

  /** Replaces the subscription on every relay (new topics after an epoch change). */
  subscribe(filter: NostrFilter | null): void {
    this.filter = filter;
    for (const c of this.conns) this.sendSub(c);
  }

  /** Sends to every open relay. Returns how many took it. */
  publish(event: NostrEvent): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.ws?.readyState !== OPEN) continue;
      try {
        c.ws.send(JSON.stringify(["EVENT", event]));
        n++;
      } catch {
        /* the next reconnect resends nothing: callers republish on their own schedule */
      }
    }
    return n;
  }

  close(): void {
    this.closed = true;
    for (const c of this.conns) {
      clearTimeout(c.timer);
      const ws = c.ws;
      c.ws = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    }
    this.onStatus(0);
  }

  private sendSub(c: Conn): void {
    if (c.ws?.readyState !== OPEN) return;
    try {
      c.ws.send(JSON.stringify(["CLOSE", SUB_ID]));
      if (this.filter && this.filter["#t"].length > 0) c.ws.send(JSON.stringify(["REQ", SUB_ID, this.filter]));
    } catch {
      /* reconnect sends it again */
    }
  }

  private connect(c: Conn): void {
    if (this.closed) return;
    let ws: SocketLike;
    try {
      ws = this.factory(c.url);
    } catch {
      this.retry(c);
      return;
    }
    c.ws = ws;
    ws.onopen = () => {
      c.tries = 0;
      this.sendSub(c);
      this.onStatus(this.openCount);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data.length > 128 * 1024) return;
      const m = parseRelayMessage(ev.data);
      if (!m || m.type !== "EVENT" || m.sub !== SUB_ID) return;
      if (!verifyEvent(m.event)) return;
      const e = m.event;
      if (this.seen.has(e.id)) return;
      this.seen.add(e.id);
      if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
      this.onEvent(e);
    };
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (c.ws === ws) c.ws = null;
      this.onStatus(this.openCount);
      this.retry(c);
    };
  }

  private retry(c: Conn): void {
    if (this.closed) return;
    const wait = RETRY_MS[Math.min(c.tries, RETRY_MS.length - 1)];
    c.tries++;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.connect(c), wait);
  }
}
