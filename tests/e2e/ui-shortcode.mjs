/**
 * UI end-to-end with short invitation codes. Two real app pages, the real Worker code
 * running in-process behind tests/mock (in-memory KV, mocked Telegram), no network.
 *
 *   npm run test:mock-ui
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { startMock } from "../mock/mockServer.mjs";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
setTimeout(() => {
  console.error("WATCHDOG: aborting after 280s");
  process.exit(2);
}, 280_000).unref();

// The app must call the mock Worker. Set before Vite reads the environment.
const mock = await startMock({ appPort: null, workerPort: 0 });
process.env.VITE_INVITE_API = mock.workerUrl;

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
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
  // The deliberate refused-code attempt logs the browser's own 404 for that request; that is expected.
  page.on("console", (m) => m.type() === "error" && !/status of 404/.test(m.text()) && errors.push(m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");
  return { page, errors };
}

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
  }
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Продължи" }).click();
}

/** Shows a short code on the current screen and returns it as typed (e.g. ABCDE-FGHJK). */
async function showShortCode(page) {
  await page.getByRole("button", { name: "Покажи кратък код" }).click();
  const el = page.locator(".short-code");
  await el.waitFor({ timeout: 30_000 });
  return (await el.innerText()).trim();
}

/** Types a short code into the enter field and submits it. */
async function enterShortCode(page, code) {
  await page.getByPlaceholder("ABCDE-FGHJK").fill(code);
  await page.getByRole("button", { name: "Провери кода" }).click();
}

try {
  const alice = await openApp();
  const bob = await openApp();
  await createIdentity(alice.page);
  await createIdentity(bob.page);
  check("identities created through the UI", true);

  // Alice shows an invitation and reads the short code aloud.
  await alice.page.getByRole("button", { name: "Свържи се" }).click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const offerCode = await showShortCode(alice.page);
  check("initiator gets a short code", /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/.test(offerCode), offerCode);

  // Bob enters the code instead of scanning.
  await bob.page.getByRole("button", { name: "Свържи се" }).click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await enterShortCode(bob.page, offerCode.toLowerCase());
  const answerCode = await showShortCode(bob.page);
  check("responder receives the invitation by short code and shows an answer code", !!answerCode, answerCode);

  // Alice enters Bob's answer code.
  await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
  // The offer code was already used by Bob: Alice's attempt with it must be refused.
  await enterShortCode(alice.page, offerCode);
  const reuseError = await alice.page.locator('[role="alert"]').first().innerText({ timeout: 15_000 }).catch(() => "");
  check("a used code is refused", reuseError.length > 0, reuseError);
  await enterShortCode(alice.page, answerCode);

  await alice.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  await bob.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  const codeA = await alice.page.locator(".safety-code").innerText();
  const codeB = await bob.page.locator(".safety-code").innerText();
  check("safety code identical on both screens", codeA === codeB && codeA.split("·").length === 6, codeA);

  await alice.page.getByPlaceholder("Например: Иван").fill("Боб");
  await bob.page.getByPlaceholder("Например: Иван").fill("Алиса");
  await alice.page.getByRole("button", { name: "Думите съвпадат" }).click();
  await bob.page.getByRole("button", { name: "Думите съвпадат" }).click();
  await alice.page.locator(".chat").waitFor({ timeout: 30_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 30_000 });
  check("both sides enter the chat", true);

  await alice.page.locator(".composer input").fill("Съобщение с кратък код");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").first().waitFor({ timeout: 30_000 });
  const got = await bob.page.locator(".messages .msg.in").first().innerText();
  check("encrypted message arrives after a short-code handshake", got.includes("Съобщение с кратък код"), got);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("ui run completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
  await mock.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
