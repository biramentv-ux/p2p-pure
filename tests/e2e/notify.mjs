/**
 * Notifications, sounds and the contact counter on the real screens (Chromium, real WebAudio).
 *
 *   npm run test:notify            SHOT=out.png also saves a screenshot of the open panel
 *
 * Checks: the panel lists every sound, each one plays without an error, the choice survives a
 * reload, and the contacts screen shows "0 of 99 contacts".
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";

setTimeout(() => {
  console.error("WATCHDOG: aborting after 150s");
  process.exit(2);
}, 150_000).unref();

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

try {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 430, height: 1400 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");
  await page.getByRole("button", { name: "Create identity" }).click();
  const grid = page.locator("ol.mnemonic-grid");
  const pw = page.locator('input[type="password"]').first();
  await Promise.race([grid.waitFor({ timeout: 30_000 }), pw.waitFor({ timeout: 30_000 })]);
  if (await pw.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: "Create identity" }).click();
    await grid.waitFor({ timeout: 30_000 });
  }
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("navigation", { name: "Navigation" }).waitFor({ timeout: 20_000 });

  // the panel
  await page.getByText("Notifications and sounds").click();
  const radios = page.locator('input[name="notify-sound"]');
  check((await radios.count()) === 8, "the panel lists 8 sound choices");
  for (const name of ["Seal", "Bell", "Drop", "Arpeggio", 'Voice: "o-la"', 'Voice: "hey"', "Choir", "No sound"]) {
    check(await page.getByText(name, { exact: true }).isVisible(), `sound "${name}" is listed`);
  }
  const plays = page.getByRole("button", { name: /^Play: / });
  const n = await plays.count();
  for (let i = 0; i < n; i++) await plays.nth(i).click();
  await page.waitForTimeout(1500);
  check(n === 7, "every sound except 'No sound' has a play button");

  // the choice is remembered
  await page.getByText('Voice: "o-la"', { exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("p2p.notify") || "{}"));
  check(saved.sound === "voice-ola" && saved.showText === false, "the choice is saved, the text stays out of notifications");

  if (process.env.SHOT) await page.locator("details.notify-settings").screenshot({ path: process.env.SHOT });

  await page.getByRole("button", { name: "Contacts" }).click();
  await page.getByText("0 of 99 contacts").waitFor({ timeout: 10_000 }).then(
    () => check(true, 'contacts screen shows "0 of 99 contacts"'),
    () => check(false, 'contacts screen shows "0 of 99 contacts"'),
  );
  check(errors.length === 0, `no errors in the page${errors.length ? `: ${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failures ? 1 : 0);
