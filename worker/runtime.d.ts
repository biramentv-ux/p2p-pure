// Minimal ambient types for the Cloudflare runtime, limited to what the Worker uses.
// Replace with `wrangler types` output if the Worker grows.
interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

/** Cloudflare Rate Limiting binding (ratelimits in wrangler.jsonc). */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Durable Object storage and identity, limited to what the signaling room uses. */
interface DurableObjectState {
  readonly storage: { setAlarm(scheduledTime: number): Promise<void> };
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/** Workers: a socket that the server side has accepted, and the pair returned by WebSocketPair. */
interface WorkerWebSocket extends WebSocket {
  accept(): void;
}

declare class WebSocketPair {
  0: WorkerWebSocket;
  1: WorkerWebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}
