/**
 * UI end-to-end: drives the REAL app (dev server, all screens) in two browser
 * pages. Creates identities, runs the QR connect flow with the paste fallback
 * (no camera needed), compares safety codes in the UI, saves the contact, and
 * exchanges encrypted messages through the chat screen.
 *
 *   npm run test:ui
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { startDemoRelay } from "./demoRelay.mjs";

// The app's demo signalling points at a local relay (the Worker is not part of this run).
const DEMO_RELAY_PORT = 8791;
const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** Serious and critical axe violations on the current page, as short strings. */
async function blockingViolations(page) {
  await page.addScriptTag({ content: AXE_SOURCE });
  const found = await page.evaluate(async (tags) => {
    const out = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return out.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes[0]?.target?.join(" ") ?? ""}`);
  }, AXE_TAGS);
  return found;
}
process.env.VITE_INVITE_API = `http://127.0.0.1:${DEMO_RELAY_PORT}`;

const CHROME_PATH =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => {
  console.error("WATCHDOG: aborting after 280s");
  process.exit(2);
}, 280_000).unref();

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const relay = await startDemoRelay(server, DEMO_RELAY_PORT);

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function openApp() {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Virtual authenticator: lets navigator.credentials work headless. Without PRF
  // support the app falls back to the password path, which this run exercises.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  await page.goto(base + "/");
  return { page, errors };
}

/** Creates an identity through the real UI (passkey, or password when PRF is missing). */
async function createIdentity(page) {
  await page.getByRole("button", { name: "Създай идентичност" }).click();
  const passwordForm = page.locator('input[type="password"]').first();
  const grid = page.locator("ol.mnemonic-grid");
  await Promise.race([passwordForm.waitFor({ timeout: 30_000 }), grid.waitFor({ timeout: 30_000 })]);
  if (await passwordForm.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await grid.waitFor({ timeout: 30_000 });
    return "password";
  }
  return "passkey";
}

/** Reads and decodes the QR canvas shown on the current screen, retrying while it draws. */
async function readQr(page) {
  const end = Date.now() + 30_000;
  for (;;) {
    await page.locator("canvas[aria-label]").first().waitFor({ timeout: 30_000 });
    const text = await page.evaluate(async () => {
      const c = document.querySelector("canvas[aria-label]");
      if (!c || c.width === 0) return null;
      const ctx = c.getContext("2d");
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const mod = await import("/src/p2p/qrDecode.ts");
      return mod.decodeQrFromPixels(img.data, img.width, img.height);
    });
    if (text) return text;
    if (Date.now() > end) throw new Error("QR code could not be decoded from the canvas");
    await page.waitForTimeout(300);
  }
}

/** Pastes a payload into the scanner's manual-input fallback and submits it. */
async function pasteCode(page, payload) {
  await page.locator("details summary").click();
  await page.locator('textarea[aria-label="Поканен код"]').fill(payload);
  await page.getByRole("button", { name: "Използвай кода" }).click();
}

try {
  const alice = await openApp();
  const bob = await openApp();

  const modeA = await createIdentity(alice.page);
  const modeB = await createIdentity(bob.page);
  // Confirm the 12 words
  for (const p of [alice.page, bob.page]) {
    await p.locator('input[type="checkbox"]').check();
    await p.getByRole("button", { name: "Продължи" }).click();
  }
  check("identities created through the UI", true, `alice=${modeA}, bob=${modeB}`);

  // Alice: show invitation
  await alice.page.getByRole("button", { name: "Свържи се" }).click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const offer = await readQr(alice.page);
  check("initiator shows a decodable invitation QR", typeof offer === "string" && offer.startsWith("p2p1:"));

  // Bob: scan (paste fallback) the invitation, then show his answer
  await bob.page.getByRole("button", { name: "Свържи се" }).click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await pasteCode(bob.page, offer);
  const answer = await readQr(bob.page);
  check("responder shows a decodable answer QR", typeof answer === "string" && answer.startsWith("p2p1:"));

  // Alice: scan the answer
  await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
  await pasteCode(alice.page, answer);

  // Both sides: safety code confirmation screens
  await alice.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  await bob.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  const codeA = await alice.page.locator(".safety-code").innerText();
  const codeB = await bob.page.locator(".safety-code").innerText();
  check("safety code shown identically on both screens", codeA === codeB && codeA.split("·").length === 6, codeA);

  await alice.page.getByPlaceholder("Например: Иван").fill("Боб");
  await bob.page.getByPlaceholder("Например: Иван").fill("Алиса");
  await alice.page.getByRole("button", { name: "Думите съвпадат" }).click();
  await bob.page.getByRole("button", { name: "Думите съвпадат" }).click();

  // Both enter the chat
  await alice.page.locator(".chat").waitFor({ timeout: 30_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 30_000 });
  check("both sides enter the chat after confirming", true);

  // Encrypted message Alice -> Bob
  await alice.page.locator(".composer input").fill("Здрасти, Алиса тук");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").first().waitFor({ timeout: 30_000 });
  const got = await bob.page.locator(".messages .msg.in").first().innerText();
  check("message arrives decrypted in the other chat", got.includes("Здрасти, Алиса тук"), got);

  // Reply Bob -> Alice
  await bob.page.locator(".composer input").fill("Чувам те, Боб");
  await bob.page.getByRole("button", { name: "Изпрати" }).click();
  await alice.page.locator(".messages .msg.in").first().waitFor({ timeout: 30_000 });
  check(
    "reply arrives decrypted",
    (await alice.page.locator(".messages .msg.in").first().innerText()).includes("Чувам те"),
  );

  // Photo Alice -> Bob (gallery input), then Bob -> Alice (camera input)
  const pngB64 = await alice.page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 900;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1600, 900);
    g.addColorStop(0, "#d33");
    g.addColorStop(1, "#33d");
    x.fillStyle = g;
    x.fillRect(0, 0, 1600, 900);
    return c.toDataURL("image/png").split(",")[1];
  });
  const png = Buffer.from(pngB64, "base64");
  await alice.page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "foto.png", mimeType: "image/png", buffer: png });
  await bob.page.locator(".messages .msg.in img.msg-image").waitFor({ timeout: 30_000 });
  const widthB = await bob.page.locator(".messages .msg.in img.msg-image").evaluate((i) => i.naturalWidth);
  check("photo from the gallery arrives and renders in the other chat", widthB > 0, `width=${widthB}`);
  await alice.page.locator(".messages .msg.out img.msg-image").waitFor({ timeout: 10_000 });
  check("sender also sees the photo it sent", true);

  await bob.page
    .locator('input[type="file"]')
    .nth(0)
    .setInputFiles({ name: "kamera.png", mimeType: "image/png", buffer: png });
  await alice.page.locator(".messages .msg.in img.msg-image").waitFor({ timeout: 30_000 });
  check("photo taken with the camera input arrives", true);

  // Contact is saved and listed as verified
  await alice.page.getByRole("button", { name: "Назад" }).click();
  await alice.page.getByRole("button", { name: "Контакти" }).click();
  const listed = await alice.page.locator(".contact").innerText();
  // The badge is uppercased by CSS, so compare case-insensitively.
  check("verified contact saved and listed", listed.includes("Боб") && listed.toLowerCase().includes("потвърден"), listed);

  // Reconnect to the verified contact: no safety step, history is still there
  await alice.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const offer2 = await readQr(alice.page);
  await bob.page.getByRole("button", { name: "Назад" }).click();
  await bob.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await pasteCode(bob.page, offer2);
  const answer2 = await readQr(bob.page);
  await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
  await pasteCode(alice.page, answer2);
  await alice.page.locator(".chat").waitFor({ timeout: 60_000 });
  check("reconnect to a verified contact skips the safety step", (await alice.page.locator(".safety-code").count()) === 0);
  // History loads after the chat screen is visible; wait for it rather than reading too early.
  await alice.page.locator(".messages .msg").filter({ hasText: "Здрасти, Алиса тук" }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  check(
    "chat history from the first session is still there",
    (await alice.page.locator(".messages").innerText()).includes("Здрасти, Алиса тук"),
  );
  await alice.page.locator(".composer input").fill("Пак здрасти");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "Пак здрасти" }).waitFor({ timeout: 30_000 });
  check("encrypted messaging works in the new session", true);

  // Demo signalling: the same two people reconnect through a room code, no QR and no paste.
  await alice.page.getByRole("button", { name: "Назад" }).click();
  await alice.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await alice.page.getByRole("button", { name: "Демо (стая)" }).click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const roomCode = (await alice.page.locator(".short-code").innerText()).trim();
  check("demo: host shows a room code", /^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/.test(roomCode), roomCode);

  await bob.page.getByRole("button", { name: "Назад" }).click();
  await bob.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await bob.page.getByRole("button", { name: "Демо (стая)" }).click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await bob.page.getByLabel("Кратък код").fill(roomCode);
  await bob.page.getByRole("button", { name: "Присъедини се" }).click();

  await alice.page.locator(".chat").waitFor({ timeout: 60_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 60_000 });
  check("demo: both sides reach the chat through the room", true);

  await alice.page.locator(".composer input").fill("Стаята работи");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "Стаята работи" }).waitFor({ timeout: 30_000 });
  check("demo: encrypted message arrives over the reconnected channel", true);

  // Dark theme on real session screens: chat, outgoing call, and a group.
  await alice.page.emulateMedia({ colorScheme: "dark" });
  await alice.page.waitForTimeout(300);
  const darkChat = await blockingViolations(alice.page);
  check("dark: chat screen has no serious accessibility violations", darkChat.length === 0, darkChat.join(" | "));

  // Outgoing audio call, then hang up.
  await alice.page.getByRole("button", { name: "Аудио разговор" }).click();
  await alice.page.locator('.call-panel[aria-label="Разговор"]').waitFor({ timeout: 15_000 });
  await alice.page.waitForTimeout(300);
  const darkAudio = await blockingViolations(alice.page);
  check("dark: outgoing audio call screen passes", darkAudio.length === 0, darkAudio.join(" | "));
  await alice.page.getByRole("button", { name: "Край", exact: true }).click();

  // Outgoing video call (fake camera from the browser flags), then hang up.
  await alice.page.getByRole("button", { name: "Видео разговор" }).click();
  await alice.page.locator('.call-panel[aria-label="Разговор"]').waitFor({ timeout: 15_000 });
  await alice.page.waitForTimeout(300);
  const darkVideo = await blockingViolations(alice.page);
  check("dark: outgoing video call screen passes", darkVideo.length === 0, darkVideo.join(" | "));
  await alice.page.getByRole("button", { name: "Край", exact: true }).click();

  // Incoming call: Bob calls Alice, Alice's screen shows the incoming panel, then she declines.
  await bob.page.getByRole("button", { name: "Аудио разговор" }).click();
  await alice.page.locator('.call-panel[aria-label="Входящ разговор"]').waitFor({ timeout: 20_000 });
  await alice.page.waitForTimeout(300);
  const darkIncoming = await blockingViolations(alice.page);
  check("dark: incoming call screen passes", darkIncoming.length === 0, darkIncoming.join(" | "));
  await alice.page.locator('.call-panel[aria-label="Входящ разговор"]').getByRole("button", { name: "Откажи" }).click();
  await bob.page.getByRole("button", { name: "Край", exact: true }).click().catch(() => undefined);

  await alice.page.getByRole("button", { name: "Назад" }).click();
  await alice.page.getByRole("button", { name: "Контакти", exact: true }).click();
  await alice.page.getByRole("button", { name: "Групов чат", exact: true }).click();
  await alice.page.getByLabel("Име на групата").fill("Тест група");
  await alice.page.getByLabel("Вашето име в групата").fill("Алиса");
  await alice.page.getByRole("button", { name: "Създай групата" }).click();
  await alice.page.locator("h1", { hasText: "Тест група" }).waitFor({ timeout: 15_000 });
  await alice.page.waitForTimeout(300);
  const darkGroup = await blockingViolations(alice.page);
  check("dark: group screen has no serious accessibility violations", darkGroup.length === 0, darkGroup.join(" | "));

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("ui run completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
  log("closing");
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await relay.close();
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
