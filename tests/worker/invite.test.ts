import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, { type Env } from "../../worker/index";
import { MemoryKV } from "./memoryKv";

const kv = new MemoryKV();
const env: Env = {
  TELEGRAM_BOT_TOKEN: "123:TEST",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
  DELIVERIES: kv as unknown as KVNamespace,
};
const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const BASE = "https://tg.example.test";

function post(body: unknown, raw?: string): Request {
  return new Request(`${BASE}/invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: "GET" });
}

async function call(req: Request): Promise<Response> {
  return worker.fetch(req, env);
}

beforeEach(() => {
  kv.clear();
  vi.restoreAllMocks();
});

describe("POST /invite", () => {
  it("stores the invitation and returns a short code", async () => {
    const res = await call(post({ invitation: INVITE }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; expiresInSec: number };
    expect(body.code).toMatch(/^[2-9A-HJKMNPQRSTVWXYZ]{10}$/);
    expect(body.expiresInSec).toBe(600);
    expect(await kv.get(`i:${body.code}`)).toBe(INVITE);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects malformed invitations", async () => {
    expect((await call(post({ invitation: "not an invitation" }))).status).toBe(400);
    expect((await call(post({ invitation: 42 }))).status).toBe(400);
    expect((await call(post(null, "{not json"))).status).toBe(400);
  });

  it("refuses oversized bodies before parsing", async () => {
    const res = await call(post(null, "x".repeat(5000)));
    expect(res.status).toBe(413);
  });
});

describe("GET /invite/:code", () => {
  it("returns the invitation once, then 404", async () => {
    const { code } = (await (await call(post({ invitation: INVITE }))).json()) as { code: string };

    const first = await call(get(`/invite/${code}`));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ invitation: INVITE });

    const second = await call(get(`/invite/${code}`));
    expect(second.status).toBe(404);
  });

  it("accepts typed input with lowercase and dashes", async () => {
    const { code } = (await (await call(post({ invitation: INVITE }))).json()) as { code: string };
    const typed = `${code.slice(0, 5).toLowerCase()}-${code.slice(5).toLowerCase()}`;
    const res = await call(get(`/invite/${typed}`));
    expect(res.status).toBe(200);
  });

  it("rejects codes outside the alphabet and broken encodings", async () => {
    expect((await call(get("/invite/AAAAA0AAAA"))).status).toBe(400);
    expect((await call(get("/invite/%E0%A4%A"))).status).toBe(400);
  });

  it("returns 404 for unknown codes", async () => {
    expect((await call(get("/invite/ABCDEFGHJK"))).status).toBe(404);
  });
});

describe("routing", () => {
  it("answers CORS preflight for /invite", async () => {
    const res = await call(new Request(`${BASE}/invite/ABCDEFGHJK`, { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("keeps the Telegram webhook protected by its secret", async () => {
    const res = await call(
      new Request(`${BASE}/webhook`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(403);
  });
});
