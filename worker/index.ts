// Signaling Worker for signed p2p1 invitations. Two paths:
//  - Telegram: forwards an invitation between two private chats. Stores only
//    pending deliveries (token -> chat and message ids) until the button is pressed
//    or the 10-minute TTL passes.
//  - Short codes (/invite): holds one invitation under a 10-character code for
//    10 minutes. The first GET returns it and deletes it. Invitations are not logged.
// The Worker never changes invitation contents beyond format validation; the
// client verifies the signature.

import {
  DELETE_CALLBACK_PREFIX,
  DELIVERY_TTL_MS,
  INVITE_TTL_SEC,
  deliveryKey,
  encodeChatCode,
  inviteKey,
  isAuthorizedWebhook,
  isValidInvitation,
  newDeliveryToken,
  newInviteCode,
  normalizeInviteCode,
  parseCommand,
  parseDeleteCallback,
} from "./logic";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /**
   * Pending deliveries (token -> chat and message ids), each with a due time,
   * and short-code invitations (code -> signed invitation), each with a TTL.
   */
  DELIVERIES: KVNamespace;
}

/** Short-code bodies are small JSON objects; anything larger is refused before parsing. */
const MAX_INVITE_BODY_CHARS = 4096;
const MAX_INVITE_ATTEMPTS = 5;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Stores an invitation under a fresh short code. Retries on the rare code collision. */
async function storeInvitation(env: Env, invitation: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_INVITE_ATTEMPTS; attempt++) {
    const code = newInviteCode();
    if ((await env.DELIVERIES.get(inviteKey(code))) !== null) continue;
    await env.DELIVERIES.put(inviteKey(code), invitation, { expirationTtl: INVITE_TTL_SEC });
    return code;
  }
  return null;
}

/** Returns the invitation for a code and deletes it, so each code works once. */
async function takeInvitation(env: Env, code: string): Promise<string | null> {
  const key = inviteKey(code);
  const invitation = await env.DELIVERIES.get(key);
  if (invitation === null) return null;
  await env.DELIVERIES.delete(key);
  return invitation;
}

/** What the Worker remembers about one delivered invitation. Nothing else is stored. */
export interface Delivery {
  recipientChatId: number;
  messageId: number;
  dueAt: number;
}

interface TelegramUpdate {
  message?: {
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

const TELEGRAM_API = "https://api.telegram.org";

/** Shown by /help. Keep in sync with BOT_COMMANDS in setup-bot.mjs. */
export const HELP_TEXT =
  "Как работи ботът:\n\n" +
  "1. /start — показва твоя код за получаване.\n" +
  "2. Дай кода си на човека, с когото искаш да се свържеш.\n" +
  "3. Той изпраща: /send <твоят код>, нов ред, после поканата от приложението.\n" +
  "4. Поканата се препраща до теб. Постави я в приложението: Свържи се → Постави покана.\n\n" +
  "Ботът не съхранява съобщения и покани. Съдържанието се проверява в приложението, не тук.";

async function callApi(env: Env, method: string, body: unknown): Promise<unknown | null> {
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
  return data?.ok ? data.result ?? true : null;
}

async function sendText(
  env: Env,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ messageId: number } | null> {
  const result = (await callApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  })) as { message_id?: number } | null;
  return result && typeof result.message_id === "number" ? { messageId: result.message_id } : null;
}

/** Deletes a message the bot sent. Returns false if Telegram refuses (already gone, too old). */
async function deleteBotMessage(env: Env, chatId: number, messageId: number): Promise<boolean> {
  return (await callApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId })) !== null;
}

/**
 * Deletes deliveries whose time has passed. Runs on a cron trigger, so messages
 * the recipient never clicked on still disappear after DELIVERY_TTL_MS.
 */
export async function purgeDueDeliveries(env: Env, now = Date.now()): Promise<number> {
  let purged = 0;
  let cursor: string | undefined;
  do {
    const page: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
      await env.DELIVERIES.list({ prefix: "d:", cursor });
    for (const { name } of page.keys) {
      const delivery = (await env.DELIVERIES.get(name, "json")) as Delivery | null;
      if (!delivery || delivery.dueAt > now) continue;
      await deleteBotMessage(env, delivery.recipientChatId, delivery.messageId);
      await env.DELIVERIES.delete(name);
      purged++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return purged;
}

/** Handles the "Копирах — изтрий" button press. */
async function handleDeleteButton(env: Env, cb: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const token = parseDeleteCallback(cb.data);
  const pressedIn = cb.message?.chat.id;
  const delivery = token ? ((await env.DELIVERIES.get(deliveryKey(token!), "json")) as Delivery | null) : null;

  // Only the recipient's own chat may delete the message, and only while it is pending.
  if (!delivery || pressedIn !== delivery.recipientChatId) {
    await callApi(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Вече е изтрито." });
    return;
  }
  await env.DELIVERIES.delete(deliveryKey(token!));
  await deleteBotMessage(env, delivery.recipientChatId, delivery.messageId);
  await callApi(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Поканата е изтрита." });
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await purgeDueDeliveries(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/invite")) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/invite") {
      const text = await request.text();
      if (text.length > MAX_INVITE_BODY_CHARS) return json({ error: "too_large" }, 413);
      let invitation: unknown;
      try {
        invitation = (JSON.parse(text) as { invitation?: unknown }).invitation;
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      if (typeof invitation !== "string" || !isValidInvitation(invitation)) {
        return json({ error: "invalid_invitation" }, 400);
      }
      const code = await storeInvitation(env, invitation);
      if (!code) return json({ error: "busy" }, 503);
      return json({ code, expiresInSec: INVITE_TTL_SEC }, 201);
    }

    const codeMatch = /^\/invite\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && codeMatch) {
      const code = normalizeInviteCode(safeDecode(codeMatch[1]) ?? "");
      if (!code) return json({ error: "invalid_code" }, 400);
      const invitation = await takeInvitation(env, code);
      if (!invitation) return json({ error: "not_found" }, 404);
      return json({ invitation });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    // Only Telegram, which knows the secret set via setWebhook, may call us.
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!isAuthorizedWebhook(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (update.callback_query) {
      if (update.callback_query.data?.startsWith(DELETE_CALLBACK_PREFIX)) {
        await handleDeleteButton(env, update.callback_query);
      }
      return new Response("ok", { status: 200 });
    }

    const msg = update.message;
    // Respond 200 to anything we do not handle so Telegram does not retry.
    if (!msg || typeof msg.text !== "string" || msg.chat.type !== "private") {
      return new Response("ok", { status: 200 });
    }

    const cmd = parseCommand(msg.text);
    switch (cmd.kind) {
      case "start":
        await sendText(
          env,
          msg.chat.id,
          `Твоят код за получаване: ${encodeChatCode(msg.chat.id)}\n\n` +
            "Дай този код на другия човек. Той ще изпрати: /send <код>, нов ред, и поканата от приложението.",
        );
        break;

      case "help":
        await sendText(env, msg.chat.id, HELP_TEXT);
        break;

      case "send": {
        const token = newDeliveryToken();
        const delivered = await sendText(
          env,
          cmd.targetChatId,
          `Покана за P2P връзка:\n${cmd.invitation}\n\nПостави я в приложението: Свържи се → Постави покана.\nСлед като я копираш, натисни бутона, за да се изтрие.`,
          {
            reply_markup: {
              inline_keyboard: [[{ text: "Копирах — изтрий", callback_data: DELETE_CALLBACK_PREFIX + token }]],
            },
          },
        );
        if (delivered) {
          const record: Delivery = {
            recipientChatId: cmd.targetChatId,
            messageId: delivered.messageId,
            dueAt: Date.now() + DELIVERY_TTL_MS,
          };
          // Saved only after the message exists, so a failed send leaves no record.
          await env.DELIVERIES.put(deliveryKey(token), JSON.stringify(record), {
            expirationTtl: Math.ceil(DELIVERY_TTL_MS / 1000) + 300,
          });
        }
        await sendText(
          env,
          msg.chat.id,
          delivered
            ? "Поканата е изпратена."
            : "Не успях да изпратя поканата. Получателят трябва първо да стартира бота с /start.",
        );
        break;
      }

      case "error":
        await sendText(env, msg.chat.id, cmd.reason);
        break;

      case "ignore":
        break;
    }

    return new Response("ok", { status: 200 });
  },
};
