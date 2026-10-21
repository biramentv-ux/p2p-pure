/**
 * Loads the unpacked extension into real Chromium and drives its popup.
 *
 *   npm run test:extension-browser
 *
 * Checks: the service worker starts, the popup renders in English and Bulgarian,
 * and the "Open messenger" button opens the messenger URL in a new tab.
 * The messenger host itself is not reachable from the sandbox, so the check looks
 * at the tab's URL, not at the page content.
 */
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXTENSION = resolve("extension");
const APP_URL = "https://dyrakarmy.online/";
const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

setTimeout(() => {
  console.error("WATCHDOG: aborting after 150s");
  process.exit(2);
}, 150_000).unref();

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function runWithLanguage(lang) {
  const userDataDir = mkdtempSync(join(tmpdir(), "p2p-ext-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--lang=${lang}`,
    ],
  });
  try {
    let [worker] = ctx.serviceWorkers();
    if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
    const extId = new URL(worker.url()).host;
    check(`[${lang}] service worker starts from the manifest`, worker.url().endsWith("/service-worker.js"));

    // The extension CSP forbids inline <script> tags, so axe is provided as an init script
    // (which runs before page scripts and is not subject to the extension page CSP).
    await ctx.addInitScript({ content: AXE_SOURCE });

    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector("#open");
    const title = await popup.textContent("h1");
    check(`[${lang}] popup title`, title === "P2P Messenger", title);

    const openLabel = await popup.textContent("#open");
    const expectedOpen = lang === "bg" ? "Отвори месинджъра" : "Open messenger";
    check(`[${lang}] popup button text follows the browser language`, openLabel === expectedOpen, openLabel);

    const status = await popup.textContent("#status");
    check(`[${lang}] popup shows a status line`, status.length > 0, status);

    const blocking = await popup.evaluate(async () => {
      const out = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
      return out.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
    });
    check(`[${lang}] popup has no serious or critical accessibility violations`, blocking.length === 0, blocking.join(", "));

    // The tab state is read from the service worker (chrome.tabs), not from the page:
    // the sandbox cannot reach the public host, so the tab shows a network error page.
    const messengerTabs = () =>
      worker.evaluate(
        async (pattern) => (await chrome.tabs.query({ url: pattern })).map((t) => t.id),
        `${APP_URL}*`,
      );

    const before = await messengerTabs();
    await popup.click("#open");
    await new Promise((r) => setTimeout(r, 1500));
    const afterFirst = await messengerTabs();
    check(`[${lang}] "Open messenger" opens one messenger tab`, before.length === 0 && afterFirst.length === 1, `tabs: ${afterFirst.length}`);

    // Second press must bring the existing tab forward, not open another one.
    const popup2 = await ctx.newPage();
    await popup2.goto(`chrome-extension://${extId}/popup.html`);
    await popup2.waitForSelector("#open");
    const statusNow = await popup2.textContent("#status");
    await popup2.click("#open");
    await new Promise((r) => setTimeout(r, 1000));
    const afterSecond = await messengerTabs();
    check(
      `[${lang}] second press reuses the same tab`,
      afterSecond.length === 1 && afterSecond[0] === afterFirst[0],
      `status: ${statusNow}`,
    );
  } finally {
    await ctx.close();
  }
}

try {
  await runWithLanguage("en-US");
  await runWithLanguage("bg");
} catch (err) {
  check("browser run completed", false, err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
