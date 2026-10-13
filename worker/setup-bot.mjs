// One-time bot setup: registers the command menu, description and webhook.
// Run from the repo root with the token and secret in environment variables
// (never pass them as arguments, so they do not end up in shell history):
//
//   node worker/setup-bot.mjs
//
// Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// Optional env: WEBHOOK_URL (default https://tg.dyrakarmy.online/webhook)

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const webhookUrl = process.env.WEBHOOK_URL || "https://tg.dyrakarmy.online/webhook";

if (!token || !secret) {
  console.error("Нужни са TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET в променливите на средата.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET може да съдържа само букви, цифри, _ и -.");
  process.exit(1);
}

/** Menu shown when the user taps the "/" button. Keep in sync with HELP_TEXT in worker/index.ts. */
const BOT_COMMANDS = [
  { command: "start", description: "Моят код за получаване" },
  { command: "send", description: "Изпрати покана: /send <код>" },
  { command: "help", description: "Как работи ботът" },
];

const DESCRIPTION =
  "Препраща покани за P2P връзка между двама души. Не съхранява съобщения и не чете покани.";
const SHORT_DESCRIPTION = "Препраща покани за P2P връзка. Без съхранение.";

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`${method} се провали: ${data.description ?? res.status}`);
  }
  console.log(`✔ ${method}`);
}

try {
  await call("setMyCommands", { commands: BOT_COMMANDS });
  await call("setMyCommands", { commands: BOT_COMMANDS, language_code: "bg" });
  await call("setMyDescription", { description: DESCRIPTION });
  await call("setMyShortDescription", { short_description: SHORT_DESCRIPTION });
  await call("setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  console.log("Готово. Изпрати /start на бота, за да провериш.");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
