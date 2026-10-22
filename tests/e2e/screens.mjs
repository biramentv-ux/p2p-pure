/**
 * Screenshots of every main screen on a phone viewport, in both themes, for a visual check.
 * Writes PNG files to SHOT_DIR (default: ./screens-out). Not part of the test suite.
 *   SHOT_DIR=... npm run -s  (see scratchpad usage) -> node tests/e2e/screens.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT = process.env.SHOT_DIR ?? "screens-out";
mkdirSync(OUT, { recursive: true });
setTimeout(() => { console.error("WATCHDOG"); process.exit(2); }, 560_000).unref();

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: CHROME_PATH, headless: true,
  args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const shot = (page, name) => page.screenshot({ path: join(OUT, name + ".png"), fullPage: true });

const PASSWORD = "dolga parola 2026";
setTimeout(() => {
  console.error("WATCHDOG: aborting after 560s");
  process.exit(2);
}, 560_000).unref();

async function openApp() {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");
  return { ctx, page, errors };
}

async function createIdentity(page) {
  await page.getByRole("button", { name: "Създай идентичност" }).click();
  const pwd = page.locator('input[type="password"]').first();
  const grid = page.locator("ol.mnemonic-grid");
  await Promise.race([pwd.waitFor({ timeout: 30_000 }), grid.waitFor({ timeout: 30_000 })]);
  if (await pwd.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await grid.waitFor({ timeout: 30_000 });
  }
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Продължи" }).click();
}

async function readQr(page) {
  const end = Date.now() + 30_000;
  for (;;) {
    await page.locator("canvas[aria-label]").first().waitFor({ timeout: 30_000 });
    const text = await page.evaluate(async () => {
      const c = document.querySelector("canvas[aria-label]");
      if (!c || c.width === 0) return null;
      const img = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      const mod = await import("/src/p2p/qrDecode.ts");
      return mod.decodeQrFromPixels(img.data, img.width, img.height);
    });
    if (text) return text;
    if (Date.now() > end) throw new Error("QR could not be decoded");
    await page.waitForTimeout(300);
  }
}

async function pasteCode(page, payload) {
  await page.locator("details summary").click();
  await page.locator('textarea[aria-label="Поканен код"]').fill(payload);
  await page.getByRole("button", { name: "Използвай кода" }).click();
}

/** Connects two fresh pages; a stalled headless ICE attempt is retried with new pages. */
async function connectPair(attempts = 3) {
  for (let n = 1; n <= attempts; n++) {
    const alice = await openApp();
    const bob = await openApp();
    try {
      await createIdentity(alice.page);
      await createIdentity(bob.page);
      await alice.page.getByRole("button", { name: "Свържи се" }).click();
      await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
      const offer = await readQr(alice.page);
      await bob.page.getByRole("button", { name: "Свържи се" }).click();
      await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
      await pasteCode(bob.page, offer);
      const answer = await readQr(bob.page);
      await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
      await pasteCode(alice.page, answer);
      await alice.page.locator(".safety-code").waitFor({ timeout: 45_000 });
      await alice.page.getByPlaceholder("Например: Иван").fill("Боб");
      await bob.page.getByPlaceholder("Например: Иван").fill("Алиса");
      await alice.page.getByRole("button", { name: "Думите съвпадат" }).click();
      await bob.page.getByRole("button", { name: "Думите съвпадат" }).click();
      await alice.page.locator(".chat").waitFor({ timeout: 30_000 });
      await bob.page.locator(".chat").waitFor({ timeout: 30_000 });
      console.log(`  connected on attempt ${n}`);
      return { alice, bob };
    } catch (err) {
      console.log(`  attempt ${n} stalled: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      await alice.ctx.close();
      await bob.ctx.close();
    }
  }
  throw new Error(`connection did not establish in ${attempts} attempts`);
}


const VIEW = { width: 390, height: 844 };
try {
  // Fresh pair in dark; repeat the capture in light by re-using the same identities.
  const { alice, bob } = await connectPair();
  for (const page of [alice.page, bob.page]) await page.setViewportSize(VIEW);
  await alice.page.locator(".composer input").fill("Здрасти! Това е тест на хибридния стил.");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "Здрасти" }).waitFor({ timeout: 30_000 });
  await bob.page.getByRole("button", { name: "Отвори" }).first().click().catch(() => {});
  await bob.page.locator(".composer input").fill("Получено. Ето отговор.");
  await bob.page.getByRole("button", { name: "Изпрати" }).click();
  await alice.page.locator(".messages .msg.in").filter({ hasText: "Получено" }).waitFor({ timeout: 30_000 });

  for (const scheme of ["dark", "light"]) {
    for (const page of [alice.page, bob.page]) await page.emulateMedia({ colorScheme: scheme });
    await shot(alice.page, `${scheme}-1-chat`);
    await alice.page.getByRole("button", { name: "Аудио разговор" }).click().catch(() => {});
    await alice.page.waitForTimeout(800);
    await shot(alice.page, `${scheme}-2-call-outgoing`);
    await alice.page.getByRole("button", { name: "Край" }).click().catch(() => {});
    await alice.page.waitForTimeout(500);
    // back to the contacts list via the chat header
    await alice.page.getByRole("button", { name: /Назад|Затвори|Контакти/ }).first().click().catch(() => {});
    await alice.page.waitForTimeout(500);
    await shot(alice.page, `${scheme}-3-contacts`);
    await alice.page.getByRole("button", { name: "Свържи се" }).click().catch(() => {});
    await alice.page.waitForTimeout(400);
    await shot(alice.page, `${scheme}-4-connect`);
    await alice.page.getByRole("button", { name: "Покажи моята покана" }).click().catch(() => {});
    await alice.page.waitForTimeout(600);
    await shot(alice.page, `${scheme}-5-show-qr`);
    await alice.page.getByRole("button", { name: "Идентичност" }).click().catch(() => {});
    await alice.page.waitForTimeout(500);
    await shot(alice.page, `${scheme}-6-identity`);
  }
  console.log("screens written to " + OUT);
} finally {
  await browser.close();
  await server.close();
}
