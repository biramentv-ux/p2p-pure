/**
 * UI end-to-end for the cipher-suite panel: two real app pages connect with a short code,
 * one proposes ChaCha20-Poly1305, the other accepts, and both sides then exchange messages.
 * Built on the same flow as ui-shortcode.mjs. Two real app pages, the real Worker code
 * running in-process behind tests/mock (in-memory KV, mocked Telegram), no network.
 *
 *   npm run test:crypto-suite
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

  await alice.page.getByRole("button", { name: "Свържи се" }).click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const offerCode = await showShortCode(alice.page);
  await bob.page.getByRole("button", { name: "Свържи се" }).click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await enterShortCode(bob.page, offerCode.toLowerCase());
  const answerCode = await showShortCode(bob.page);
  await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
  await enterShortCode(alice.page, answerCode);

  await alice.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  await bob.page.locator(".safety-code").waitFor({ timeout: 60_000 });
  await alice.page.getByPlaceholder("Например: Иван").fill("Боб");
  await bob.page.getByPlaceholder("Например: Иван").fill("Алиса");
  await alice.page.getByRole("button", { name: "Думите съвпадат" }).click();
  await bob.page.getByRole("button", { name: "Думите съвпадат" }).click();
  await alice.page.locator(".chat").waitFor({ timeout: 30_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 30_000 });
  check("both sides are in the chat", true);

  // Both start on the default suite.
  await alice.page.getByRole("button", { name: "Криптография" }).click();
  await bob.page.getByRole("button", { name: "Криптография" }).click();
  const panelA = alice.page.locator("#crypto-panel");
  const panelB = bob.page.locator("#crypto-panel");
  check("panel shows the default method on Alice's side",
    (await panelA.innerText()).includes("AES-256-GCM"), (await panelA.innerText()).split("\n")[0]);

  // Alice proposes ChaCha20-Poly1305. Nothing changes until Bob accepts.
  await panelA.getByRole("button", { name: "Предложи ChaCha20-Poly1305" }).click();
  await panelB.getByText("Събеседникът предлага ChaCha20-Poly1305.").waitFor({ timeout: 30_000 });
  check("Bob is asked to confirm the proposal", true);
  check("Alice still shows the old method while waiting",
    (await panelA.innerText()).includes("Текущ метод: AES-256-GCM"));

  await panelB.getByRole("button", { name: "Приеми" }).click();
  await panelA.getByText("Текущ метод: ChaCha20-Poly1305").waitFor({ timeout: 30_000 });
  await panelB.getByText("Текущ метод: ChaCha20-Poly1305").waitFor({ timeout: 30_000 });
  check("both sides confirmed and now show ChaCha20-Poly1305", true);

  // Messages keep working in both directions under the new suite.
  await alice.page.locator(".composer input").fill("Съобщение с ChaCha");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "Съобщение с ChaCha" }).first().waitFor({ timeout: 30_000 });
  check("Bob receives Alice's message under ChaCha20-Poly1305", true);
  await bob.page.locator(".composer input").fill("Отговор с ChaCha");
  await bob.page.getByRole("button", { name: "Изпрати" }).click();
  await alice.page.locator(".messages .msg.in").filter({ hasText: "Отговор с ChaCha" }).first().waitFor({ timeout: 30_000 });
  check("Alice receives Bob's reply under ChaCha20-Poly1305", true);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("ui run completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
  await mock.close();
  if (failed) process.exitCode = 1;
}
