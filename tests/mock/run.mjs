/**
 * Full mock test of the Worker over real HTTP: short codes, CORS, limits, TTL expiry,
 * Telegram webhook flow (/start, /help, /send, delete button, cron purge), security.
 * No network, no secrets. Uses random free ports.
 *
 *   npm run test:mock
 */
import { startMock, MOCK_WEBHOOK_SECRET } from "./mockServer.mjs";

const mock = await startMock({ appPort: null, workerPort: 0 });
const W = mock.workerUrl;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? "  — " + detail : ""}`);
}
const post = (p, body, headers = {}) =>
  fetch(W + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ctl = (p, body = {}) => post("/__mock/" + p, body).then((r) => r.json());
const state = () => fetch(W + "/__mock/state").then((r) => r.json());
const DELETE_PREFIX = "d:"; // must equal DELETE_CALLBACK_PREFIX in worker/logic.ts
const INV = "p2p1:" + "A1b2_-".repeat(40);
const hook = (update, secret = MOCK_WEBHOOK_SECRET) =>
  post("/webhook", update, secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret });
const say = (chatId, text) => hook({ message: { chat: { id: chatId, type: "private" }, text } });
const chatCode = (id) => Buffer.from(String(id)).toString("base64url");

try {
  /* ---------- Health / routing ---------- */
  check("GET / returns ok", (await fetch(W + "/")).status === 200);
  check("unknown path is 404", (await fetch(W + "/nope")).status === 404);

  /* ---------- Short codes ---------- */
  const created = await post("/invite", { invitation: INV });
  const cj = await created.json();
  check("POST /invite -> 201 with code and 600s", created.status === 201 && cj.expiresInSec === 600 && /^[2-9A-HJKMNP-TV-Z]{10}$/.test(cj.code), JSON.stringify(cj));
  check("responses carry CORS * and no-store", created.headers.get("access-control-allow-origin") === "*" && created.headers.get("cache-control") === "no-store");
  const pre = await fetch(W + "/invite", { method: "OPTIONS" });
  check("OPTIONS /invite -> 204 with CORS", pre.status === 204 && /POST/.test(pre.headers.get("access-control-allow-methods") ?? ""));

  const g1 = await fetch(`${W}/invite/${cj.code}`);
  check("first GET returns the invitation", g1.status === 200 && (await g1.json()).invitation === INV);
  check("second GET is 404 (one-time)", (await fetch(`${W}/invite/${cj.code}`)).status === 404);

  const c2 = await (await post("/invite", { invitation: INV })).json();
  const pretty = `${c2.code.slice(0, 5)}-${c2.code.slice(5)}`.toLowerCase();
  const g2 = await fetch(`${W}/invite/${encodeURIComponent(pretty)}`);
  check("lowercase and dashed code is accepted", g2.status === 200);

  const c3 = await (await post("/invite", { invitation: INV })).json();
  check("code is stored in KV with i: prefix", (await state()).kvKeys.includes(`i:${c3.code}`));

  check("malformed code -> 400", (await fetch(`${W}/invite/abc`)).status === 400);
  check("code with forbidden letters (0,O,1,I,L,U) -> 400", (await fetch(`${W}/invite/0O1ILUABCD`)).status === 400);
  check("bad percent-encoding -> 400 (no crash)", (await fetch(`${W}/invite/%E0%A4%A`)).status === 400);
  check("unknown valid code -> 404", (await fetch(`${W}/invite/ABCDEFGHJK`)).status === 404);

  check("invalid JSON -> 400", (await post("/invite", "{not json")).status === 400);
  check("missing invitation field -> 400", (await post("/invite", {})).status === 400);
  check("non-string invitation -> 400", (await post("/invite", { invitation: 123 })).status === 400);
  check("wrong prefix -> 400", (await post("/invite", { invitation: "hello" })).status === 400);
  check("illegal characters -> 400", (await post("/invite", { invitation: "p2p1:abc def" })).status === 400);
  check("invitation over 3000 chars -> 400", (await post("/invite", { invitation: "p2p1:" + "a".repeat(3000) })).status === 400);
  check("body over 4096 chars -> 413", (await post("/invite", { invitation: INV, pad: "x".repeat(5000) })).status === 413);
  check("GET /invite (no code) is 404", (await fetch(W + "/invite")).status === 404);

  // Uniqueness across many codes
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add((await (await post("/invite", { invitation: INV })).json()).code);
  check("200 codes are all distinct", codes.size === 200);

  // TTL
  await ctl("reset");
  const t = await (await post("/invite", { invitation: INV })).json();
  await ctl("clock", { advanceMs: 599_000 });
  const stillThere = await fetch(`${W}/invite/${t.code}`);
  check("code still valid at 599 s", stillThere.status === 200);
  const t2 = await (await post("/invite", { invitation: INV })).json();
  await ctl("clock", { advanceMs: 601_000 });
  check("code expired after 601 s", (await fetch(`${W}/invite/${t2.code}`)).status === 404);

  // Concurrent one-time use: with real KV a race is possible; here we verify sequential contract and no crash.
  const t3 = await (await post("/invite", { invitation: INV })).json();
  const [a, b] = await Promise.all([fetch(`${W}/invite/${t3.code}`), fetch(`${W}/invite/${t3.code}`)]);
  const okCount = [a, b].filter((r) => r.status === 200).length;
  check("parallel fetch of one code never crashes (<=2 winners, >=1)", okCount >= 1 && okCount <= 2, `winners=${okCount}`);

  /* ---------- Telegram webhook ---------- */
  await ctl("reset");
  check("webhook without secret -> 403", (await hook({}, null)).status === 403);
  check("webhook with wrong secret -> 403", (await hook({}, "wrong")).status === 403);
  check("GET /webhook -> 404", (await fetch(W + "/webhook")).status === 404);
  const bad = await post("/webhook", "{oops", { "X-Telegram-Bot-Api-Secret-Token": MOCK_WEBHOOK_SECRET });
  check("webhook invalid JSON -> 400", bad.status === 400);

  await say(111, "/start");
  let s = await state();
  check("/start replies with the receive code", s.messages.at(-1)?.chatId === 111 && s.messages.at(-1).text.includes(chatCode(111)));
  await say(111, "/help");
  s = await state();
  check("/help replies with instructions", s.messages.at(-1).text.startsWith("Как работи ботът"));
  const before = (await state()).messages.length;
  await hook({ message: { chat: { id: 111, type: "group" }, text: "/start" } });
  await say(111, "hello there");
  check("group chats and plain text are ignored", (await state()).messages.length === before);

  await say(222, "/start"); // recipient must have started the bot
  await say(111, `/send ${chatCode(222)}\n${INV}`);
  s = await state();
  const delivered = s.messages.find((m) => m.chatId === 222 && m.text.includes(INV));
  check("/send delivers the invitation to the recipient", !!delivered);
  check("delivery has a delete button", delivered?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith(DELETE_PREFIX) === true, JSON.stringify(delivered?.replyMarkup));
  check("sender gets a confirmation", s.messages.at(-1).chatId === 111 && s.messages.at(-1).text === "Поканата е изпратена.");
  check("a d: record is stored", s.kvKeys.some((k) => k.startsWith("d:")));

  const cbData = delivered.replyMarkup.inline_keyboard[0][0].callback_data;
  // Wrong chat presses the button: must not delete.
  await hook({ callback_query: { id: "cb1", data: cbData, message: { message_id: delivered.id, chat: { id: 999 } } } });
  s = await state();
  check("button pressed from another chat does not delete", s.messages.find((m) => m.id === delivered.id).deleted === false);
  check("…and the other chat is told it is already gone", s.answers.at(-1)?.text === "Вече е изтрито.");
  // Recipient presses.
  await hook({ callback_query: { id: "cb2", data: cbData, message: { message_id: delivered.id, chat: { id: 222 } } } });
  s = await state();
  check("recipient button press deletes the message", s.messages.find((m) => m.id === delivered.id).deleted === true);
  check("…answers 'Поканата е изтрита.' and removes the record", s.answers.at(-1)?.text === "Поканата е изтрита." && !s.kvKeys.some((k) => k.startsWith("d:")));
  await hook({ callback_query: { id: "cb3", data: cbData, message: { message_id: delivered.id, chat: { id: 222 } } } });
  check("second press says already deleted", (await state()).answers.at(-1)?.text === "Вече е изтрито.");
  await hook({ callback_query: { id: "cb4", data: "other:1", message: { message_id: 1, chat: { id: 222 } } } });
  check("foreign callback data is ignored", (await state()).answers.length === 3);

  // Errors
  await say(111, "/send onlyonelinenoinvitation");
  check("/send without newline -> format hint", (await state()).messages.at(-1).text.startsWith("Формат"));
  await say(111, `/send !!!\n${INV}`);
  check("/send with bad recipient code -> error", (await state()).messages.at(-1).text === "Невалиден код на получателя.");
  await say(111, `/send ${chatCode(222)}\nnot-an-invitation`);
  check("/send with bad invitation -> error", (await state()).messages.at(-1).text.startsWith("Поканата е невалидна"));

  // Recipient never started the bot
  await ctl("telegram/block", { chatId: 333 });
  const keysBefore = (await state()).kvKeys.length;
  await say(111, `/send ${chatCode(333)}\n${INV}`);
  s = await state();
  check("failed delivery tells the sender to ask for /start", s.messages.at(-1).text.includes("/start"));
  check("failed delivery leaves no record", s.kvKeys.length === keysBefore);

  // Cron purge
  await ctl("reset");
  await say(111, `/send ${chatCode(444)}\n${INV}`);
  s = await state();
  const pending = s.messages.find((m) => m.chatId === 444);
  await ctl("cron");
  check("cron keeps a fresh delivery", (await state()).messages.find((m) => m.id === pending.id).deleted === false);
  await ctl("clock", { advanceMs: 11 * 60_000 });
  await ctl("cron");
  s = await state();
  check("cron deletes an unclicked delivery after the TTL", s.messages.find((m) => m.id === pending.id).deleted === true);
  check("cron removes the record", !s.kvKeys.some((k) => k.startsWith("d:")));

  // Cron must not touch short-code invitations
  await ctl("reset");
  const keep = await (await post("/invite", { invitation: INV })).json();
  await ctl("cron");
  check("cron leaves short codes alone", (await fetch(`${W}/invite/${keep.code}`)).status === 200);
} catch (err) {
  check("mock run completed without exception", false, err instanceof Error ? err.stack : String(err));
} finally {
  await mock.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
