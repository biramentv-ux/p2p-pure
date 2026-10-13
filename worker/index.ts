// Telegram signaling Worker: forwards signed p2p1 invitations between two
// private Telegram chats. Stateless: nothing is stored, invitations are never
// logged, and the Worker never reads or changes invitation contents beyond
// format validation (the client verifies the signature).

import { encodeChatCode, isAuthorizedWebhook, parseCommand } from "./logic";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

interface TelegramUpdate {
  message?: {
    chat: { id: number; type: string };
    text?: string;
  };
}

const TELEGRAM_API = "https://api.telegram.org";

async function sendText(env: Env, chatId: number, text: string): Promise<boolean> {
  const res = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.ok;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok", { status: 200 });
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

      case "send": {
        const delivered = await sendText(
          env,
          cmd.targetChatId,
          `Покана за P2P връзка:\n${cmd.invitation}\n\nПостави я в приложението: Свържи се → Постави покана.`,
        );
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
