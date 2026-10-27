/**
 * English package in a real browser. The page language follows the browser (en-US here),
 * the switch changes it, the choice survives a reload, and no Bulgarian text is left on
 * the screens once English is active (the "БГ" switch label itself is exempt).
 *
 *   npm run test:i18n
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
const CYRILLIC = /[Ѐ-ӿ]/;

setTimeout(() => {
  console.error("WATCHDOG: aborting after 200s");
  process.exit(2);
}, 200_000).unref();

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

/** Text of every leaf element on the page except the language switch itself. */
async function visibleText(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("main *")]
      .filter((el) => el.childElementCount === 0 && !el.closest(".lang-switch") && !el.closest("script"))
      .map((el) => el.textContent ?? "")
      .join(" \n "),
  );
}

try {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/status of 404/.test(m.text()) && errors.push(m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });

  await page.goto(base + "/");
  await page.getByRole("button", { name: "Create identity" }).waitFor({ timeout: 20_000 });
  check("English browser starts in English", (await page.getAttribute("html", "lang")) === "en");

  // Switch to Bulgarian, then back, and check the page text changes with it.
  await page.locator("select.lang-select").first().selectOption("bg");
  await page.getByRole("button", { name: "Създай идентичност" }).waitFor({ timeout: 5_000 });
  check("switch to Bulgarian updates the page", (await page.getAttribute("html", "lang")) === "bg");
  await page.reload();
  await page.getByRole("button", { name: "Създай идентичност" }).waitFor({ timeout: 20_000 });
  check("Bulgarian choice survives a reload", (await page.getAttribute("html", "lang")) === "bg");

  await page.locator("select.lang-select").first().selectOption("en");
  await page.getByRole("button", { name: "Create identity" }).waitFor({ timeout: 5_000 });
  check("switch back to English updates the page", (await page.getAttribute("html", "lang")) === "en");

  const intro = await visibleText(page);
  check("intro screen has no Bulgarian text in English", !CYRILLIC.test(intro), CYRILLIC.test(intro) ? intro.slice(0, 200) : "");

  // Create the identity in English (virtual passkey, so no password step).
  await page.getByRole("button", { name: "Create identity" }).click();
  const grid = page.locator("ol.mnemonic-grid");
  const passwordField = page.locator('input[type="password"]').first();
  await Promise.race([grid.waitFor({ timeout: 30_000 }), passwordField.waitFor({ timeout: 30_000 })]);
  if (await passwordField.isVisible()) {
    // Authenticators without PRF ask for a device password instead.
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: "Create identity" }).click();
    await grid.waitFor({ timeout: 30_000 });
  }
  check("recovery words heading is in English", await page.getByRole("heading", { name: "Write down these 12 words" }).isVisible());
  const mnemonicText = await visibleText(page);
  check("recovery screen has no Bulgarian text in English", !CYRILLIC.test(mnemonicText), CYRILLIC.test(mnemonicText) ? mnemonicText.slice(0, 200) : "");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("navigation", { name: "Navigation" }).waitFor({ timeout: 20_000 });
  check("tabs are Identity, Contacts, Connect", (await page.getByRole("button", { name: "Identity" }).count()) === 1 && (await page.getByRole("button", { name: "Contacts" }).count()) === 1 && (await page.getByRole("button", { name: "Connect" }).count()) === 1);
  check("identity QR code has an English label", (await page.locator('canvas[aria-label="Identity QR code"]').count()) === 1);

  await page.getByRole("button", { name: "Contacts" }).click();
  await page.getByText("No verified contacts yet.", { exact: false }).waitFor({ timeout: 10_000 });
  const contactsText = await visibleText(page);
  check("contacts empty state is in English", !CYRILLIC.test(contactsText), CYRILLIC.test(contactsText) ? contactsText.slice(0, 200) : "");

  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Show my invitation" }).waitFor({ timeout: 10_000 });
  const connectText = await visibleText(page);
  check("connect screen has no Bulgarian text in English", !CYRILLIC.test(connectText), CYRILLIC.test(connectText) ? connectText.slice(0, 200) : "");

  check("no page errors during the English flow", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("English flow completed", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
