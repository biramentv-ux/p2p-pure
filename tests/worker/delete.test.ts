import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { purgeDueDeliveries, type Env, type Delivery } from "../../worker/index";
import { encodeChatCode, deliveryKey, parseDeleteCallback, newDeliveryToken } from "../../worker/logic";
import { MemoryKV } from "./memoryKv";

const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SENDER = 555;
const RECIPIENT = 777;
const SENT_MESSAGE_ID = 4242;

let env: Env;
let kv: MemoryKV;
let calls: { method: string; body: Record<string, unknown> }[];

beforeEach(() => {
  kv = new MemoryKV();
  env = {
    TELEGRAM_BOT_TOKEN: "123:TEST",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
    DELIVERIES: kv as unknown as KVNamespace,
  };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/").pop() ?? "";
      const body = JSON.parse(String(init.body));
      calls.push({ method, body });
      const result = method === "sendMessage" ? { message_id: SENT_MESSAGE_ID } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function webhook(update: unknown): Request {
  return new Request("https://tg.dyrakarmy.online/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
}

async function sendInvitation(): Promise<string> {
  await worker.fetch(
    webhook({
      message: {
        chat: { id: SENDER, type: "private" },
        text: `/send ${encodeChatCode(RECIPIENT)}\n${INVITE}`,
      },
    }),
    env,
  );
  const sendCall = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === RECIPIENT)!;
  const markup = sendCall.body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  return markup.inline_keyboard[0][0].callback_data;
}

describe("delivery button", () => {
  it("attaches a delete button whose token is not part of the invitation", async () => {
    const data = await sendInvitation();
    expect(data.startsWith("d:")).toBe(true);
    const token = parseDeleteCallback(data)!;
    expect(token).not.toBeNull();
    const sendCall = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === RECIPIENT)!;
    expect(String(sendCall.body.text)).not.toContain(token);
  });

  it("stores only chat and message ids, under the token key", async () => {
    const token = parseDeleteCallback(await sendInvitation())!;
    const stored = (await kv.get(deliveryKey(token), "json")) as Delivery;
    expect(stored.recipientChatId).toBe(RECIPIENT);
    expect(stored.messageId).toBe(SENT_MESSAGE_ID);
    expect(Object.keys(stored).sort()).toEqual(["dueAt", "messageId", "recipientChatId"]);
  });

  it("deletes the message when the recipient presses the button", async () => {
    const data = await sendInvitation();
    const token = parseDeleteCallback(data)!;
    await worker.fetch(
      webhook({
        callback_query: {
          id: "cb1",
          data,
          message: { message_id: SENT_MESSAGE_ID, chat: { id: RECIPIENT } },
        },
      }),
      env,
    );
    const del = calls.find((c) => c.method === "deleteMessage");
    expect(del?.body).toEqual({ chat_id: RECIPIENT, message_id: SENT_MESSAGE_ID });
    expect(await kv.get(deliveryKey(token))).toBeNull();
  });

  it("refuses a press from another chat and leaves the message alone", async () => {
    const data = await sendInvitation();
    await worker.fetch(
      webhook({
        callback_query: { id: "cb2", data, message: { message_id: SENT_MESSAGE_ID, chat: { id: SENDER } } },
      }),
      env,
    );
    expect(calls.some((c) => c.method === "deleteMessage")).toBe(false);
  });

  it("answers an unknown or already-used token without deleting anything", async () => {
    const data = "d:" + "A".repeat(22);
    await worker.fetch(
      webhook({ callback_query: { id: "cb3", data, message: { message_id: 1, chat: { id: RECIPIENT } } } }),
      env,
    );
    expect(calls.some((c) => c.method === "deleteMessage")).toBe(false);
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  it("does not store anything when the delivery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const method = url.split("/").pop() ?? "";
        if (method === "sendMessage") return new Response(JSON.stringify({ ok: false }), { status: 403 });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }),
    );
    await worker.fetch(
      webhook({ message: { chat: { id: SENDER, type: "private" }, text: `/send ${encodeChatCode(RECIPIENT)}\n${INVITE}` } }),
      env,
    );
    expect((await kv.list({ prefix: "d:" })).keys).toHaveLength(0);
  });
});

describe("purge of due deliveries", () => {
  it("deletes messages whose time has passed and keeps the rest", async () => {
    const now = 1_000_000;
    const due = newDeliveryToken();
    const later = newDeliveryToken();
    await kv.put(deliveryKey(due), JSON.stringify({ recipientChatId: RECIPIENT, messageId: 1, dueAt: now - 1 }));
    await kv.put(deliveryKey(later), JSON.stringify({ recipientChatId: RECIPIENT, messageId: 2, dueAt: now + 60_000 }));

    const purged = await purgeDueDeliveries(env, now);

    expect(purged).toBe(1);
    expect(calls).toEqual([{ method: "deleteMessage", body: { chat_id: RECIPIENT, message_id: 1 } }]);
    expect(await kv.get(deliveryKey(due))).toBeNull();
    expect(await kv.get(deliveryKey(later))).not.toBeNull();
  });
});

describe("token helpers", () => {
  it("accepts only tokens of the exact shape", () => {
    const token = newDeliveryToken();
    expect(token).toHaveLength(22);
    expect(parseDeleteCallback(`d:${token}`)).toBe(token);
    expect(parseDeleteCallback("d:short")).toBeNull();
    expect(parseDeleteCallback("x:" + token)).toBeNull();
    expect(parseDeleteCallback(undefined)).toBeNull();
  });
});
