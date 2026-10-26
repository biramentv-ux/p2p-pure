import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import worker, { limiterKey, type Env } from "../../worker/index";
import { MemoryKV } from "./memoryKv";

const IP = "203.0.113.77";
const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

afterEach(() => vi.restoreAllMocks());

describe("worker privacy", () => {
  it("writes nothing to the console that contains an IP, a code or an invitation", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))));
    const limit = vi.fn(async () => ({ success: true }));
    const env: Env = {
      TELEGRAM_BOT_TOKEN: "1:T",
      TELEGRAM_WEBHOOK_SECRET: "s3cret",
      DELIVERIES: new MemoryKV() as unknown as KVNamespace,
      INVITE_LIMITER: { limit },
    };
    const h = { "cf-connecting-ip": IP, "content-type": "application/json" };
    const post = await worker.fetch(
      new Request("https://x.test/invite", { method: "POST", headers: h, body: JSON.stringify({ invitation: INVITE }) }),
      env,
    );
    const { code } = (await post.json()) as { code: string };
    await worker.fetch(new Request(`https://x.test/invite/${code}`, { headers: h }), env);
    await worker.fetch(new Request("https://x.test/invite/BAD!", { headers: h }), env);
    await worker.fetch(new Request("https://x.test/invite", { method: "POST", headers: h, body: "{" }), env);
    await worker.fetch(
      new Request("https://x.test/webhook", {
        method: "POST",
        headers: { ...h, "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
        body: JSON.stringify({ message: { chat: { id: 987654, type: "private" }, text: "/start" } }),
      }),
      env,
    );
    const out = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(out).toBe("[]");
    for (const [arg] of limit.mock.calls as unknown as [{ key: string }][]) {
      expect(arg.key).not.toContain(IP);
      expect(arg.key).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("hashes IPs deterministically and per secret", async () => {
    expect(await limiterKey(IP, "a")).toBe(await limiterKey(IP, "a"));
    expect(await limiterKey(IP, "a")).not.toBe(await limiterKey(IP, "b"));
    expect(await limiterKey(IP, "a")).not.toBe(await limiterKey("203.0.113.78", "a"));
  });

  it("source has no console calls and observability stays off", () => {
    for (const f of ["index.ts", "logic.ts", "room.ts"]) {
      expect(readFileSync(`worker/${f}`, "utf8")).not.toMatch(/console\./);
    }
    const cfg = readFileSync("worker/wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(cfg).toMatch(/"observability":\s*\{\s*"enabled": false/);
    expect(cfg).not.toMatch(/logpush|tail_consumers/);
  });
});
