// Signaling Worker for signed p2p1 invitations. Two paths:
//  - Telegram: forwards an invitation between two private chats. Stores only
//    pending deliveries (token -> chat and message ids) until the button is pressed
//    or the 10-minute TTL passes.
//  - Short codes (/invite): holds one invitation under a 10-character code for
//    10 minutes. The first GET returns it and deletes it. Invitations are not logged.
// The Worker never changes invitation contents beyond format validation; the
// client verifies the signature.

import { MAX_RELAY_CHARS, ROOM_TTL_MS, RoomRelay, type RoomPeer } from "./room";
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
  /**
   * Optional Cloudflare Rate Limiting binding for the invitation endpoints, keyed by client IP.
   * When it is absent (tests, local runs) requests are not limited.
   */
  INVITE_LIMITER?: RateLimiter;
  /** Demo WebSocket signaling: one SignalRoom Durable Object per room code. */
  SIGNAL_ROOM?: DurableObjectNamespace;
}

/**
 * The rate-limit key is a keyed hash (HMAC-SHA-256, first 8 bytes as hex) of the client IP,
 * so the limiter never receives the address itself. The key is a Worker secret.
 */
export async function limiterKey(ip: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret || "unset"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ip)));
  return Array.from(mac.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Invitation endpoints allow this many requests per client IP per period (see wrangler.jsonc). */
async function overInviteLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.INVITE_LIMITER) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.INVITE_LIMITER.limit({ key: await limiterKey(ip, env.TELEGRAM_WEBHOOK_SECRET) });
  return !success;
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

/**
 * Holds the two sockets of one room and relays frames between them. The relay logic is in
 * room.ts; this class only accepts sockets and sets the room's expiry alarm.
 */
export class SignalRoom {
  private readonly relay = new RoomRelay();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(_request: Request): Promise<Response> {
    if (this.relay.size >= 2) return json({ error: "room_full" }, 409);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const peer: RoomPeer = {
      send: (text) => server.send(text),
      close: (code, reason) => server.close(code, reason),
    };
    if (!this.relay.join(peer)) return json({ error: "room_full" }, 409);

    if (this.relay.size === 1) await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    server.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.length <= MAX_RELAY_CHARS) {
        this.relay.relay(peer, event.data);
      }
    });
    server.addEventListener("close", () => this.relay.leave(peer));
    server.addEventListener("error", () => this.relay.leave(peer));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Room expired: close whatever is still connected. */
  async alarm(): Promise<void> {
    this.relay.closeAll("room expired");
  }
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

    const isInviteRoute = url.pathname === "/invite" || url.pathname.startsWith("/invite/");
    if (isInviteRoute && (request.method === "POST" || request.method === "GET")) {
      if (await overInviteLimit(request, env)) {
        return json({ error: "rate_limited" }, 429);
      }
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

    // Demo WebSocket signaling. POST /ws/rooms makes a code; GET /ws/rooms/:code upgrades to
    // the room, where the first peer is the offerer and the second the answerer.
    if (request.method === "POST" && url.pathname === "/ws/rooms") {
      if (await overInviteLimit(request, env)) return json({ error: "rate_limited" }, 429);
      if (!env.SIGNAL_ROOM) return json({ error: "unavailable" }, 503);
      return json({ code: newInviteCode(), ttlSec: Math.round(ROOM_TTL_MS / 1000) }, 201);
    }
    const roomMatch = /^\/ws\/rooms\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && roomMatch) {
      if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);
      const code = normalizeInviteCode(safeDecode(roomMatch[1]) ?? "");
      if (!code) return json({ error: "invalid_code" }, 400);
      if (!env.SIGNAL_ROOM) return json({ error: "unavailable" }, 503);
      const stub = env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(code));
      return stub.fetch(request);
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
