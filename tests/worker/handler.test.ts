import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../worker/index";
import { encodeChatCode } from "../../worker/logic";
import { MemoryKV } from "./memoryKv";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "123:TEST",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
  DELIVERIES: new MemoryKV() as unknown as KVNamespace,
};
const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

interface Sent {
  url: string;
  body: { chat_id: number; text: string };
}

let sent: Sent[];
let telegramOk: boolean;

beforeEach(() => {
  sent = [];
  (env.DELIVERIES as unknown as MemoryKV).clear();
  telegramOk = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      const result = { message_id: 4242 };
      return new Response(JSON.stringify({ ok: telegramOk, result }), { status: telegramOk ? 200 : 403 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function webhook(update: unknown, secret: string | null = env.TELEGRAM_WEBHOOK_SECRET): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://tg.dyrakarmy.online/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(update),
  });
}

const privateMsg = (chatId: number, text: string) => ({
  update_id: 1,
  message: { chat: { id: chatId, type: "private" }, text },
});

describe("webhook security", () => {
  it("rejects a missing or wrong secret without calling Telegram", async () => {
    const res = await worker.fetch(webhook(privateMsg(1, "/start"), null), env);
    expect(res.status).toBe(403);
    const res2 = await worker.fetch(webhook(privateMsg(1, "/start"), "wrong"), env);
    expect(res2.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("returns 404 for other paths and methods", async () => {
    const res = await worker.fetch(new Request("https://tg.dyrakarmy.online/other"), env);
    expect(res.status).toBe(404);
    const res2 = await worker.fetch(new Request("https://tg.dyrakarmy.online/webhook"), env);
    expect(res2.status).toBe(404);
  });

  it("returns 400 for malformed JSON", async () => {
    const req = new Request("https://tg.dyrakarmy.online/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
      body: "{not json",
    });
    expect((await worker.fetch(req, env)).status).toBe(400);
  });
});

describe("commands", () => {
  it("/start replies with the sender's own code", async () => {
    await worker.fetch(webhook(privateMsg(555, "/start")), env);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(555);
    expect(sent[0].body.text).toContain(encodeChatCode(555));
  });

  it("/help replies with the instructions", async () => {
    await worker.fetch(webhook(privateMsg(555, "/help")), env);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain("/send");
  });

  it("/send forwards the invitation verbatim to the recipient and confirms to the sender", async () => {
    const code = encodeChatCode(777);
    await worker.fetch(webhook(privateMsg(555, `/send ${code}\n${INVITE}`)), env);
    expect(sent).toHaveLength(2);
    expect(sent[0].body.chat_id).toBe(777);
    expect(sent[0].body.text).toContain(INVITE);
    expect(sent[1].body.chat_id).toBe(555);
    expect(sent[1].body.text).toBe("Поканата е изпратена.");
  });

  it("tells the sender when the recipient has not started the bot", async () => {
    telegramOk = false;
    await worker.fetch(webhook(privateMsg(555, `/send ${encodeChatCode(777)}\n${INVITE}`)), env);
    expect(sent[1].body.chat_id).toBe(555);
    expect(sent[1].body.text).toContain("/start");
  });

  it("replies with the error reason for an invalid command", async () => {
    await worker.fetch(webhook(privateMsg(555, "/send garbage\nhello")), env);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(555);
  });

  it("ignores group chats and non-text updates, returning 200", async () => {
    const group = { message: { chat: { id: -100, type: "supergroup" }, text: "/start" } };
    const res = await worker.fetch(webhook(group), env);
    expect(res.status).toBe(200);
    const sticker = { message: { chat: { id: 5, type: "private" } } };
    expect((await worker.fetch(webhook(sticker), env)).status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});
