/**
 * Accessibility scan (axe-core, WCAG 2.2 A/AA) on the real screens, in Bulgarian and English.
 * Serious and critical findings fail the run. Moderate and minor ones are printed as warnings.
 *
 *   npm run test:a11y
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
const TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

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

let blocking = 0;
const warnings = [];
const passes = [];

/** Runs axe on the current page and records the result under a label. */
async function scan(page, label) {
  await page.addScriptTag({ content: AXE_SOURCE });
  const result = await page.evaluate(async (tags) => {
    const out = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
    return out.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
      sample: v.nodes[0]?.target?.join(" ") ?? "",
    }));
  }, TAGS);
  for (const v of result) {
    const line = `${label}: ${v.id} (${v.impact}, ${v.nodes} node${v.nodes === 1 ? "" : "s"}) — ${v.help} [${v.sample}]`;
    if (v.impact === "serious" || v.impact === "critical") {
      blocking++;
      console.log(`FAIL  ${line}`);
    } else {
      warnings.push(line);
    }
  }
  if (result.length === 0) passes.push(label);
  console.log(`${result.some((v) => v.impact === "serious" || v.impact === "critical") ? "FAIL" : "PASS"}  ${label}`);
}

try {
  const scheme = process.env.A11Y_SCHEME === "dark" ? "dark" : "light";
  const ctx = await browser.newContext({ locale: "en-US", colorScheme: scheme });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");

  await page.getByRole("button", { name: "Create identity" }).waitFor({ timeout: 20_000 });
  await scan(page, `[en/${scheme}] intro`);

  await page.getByRole("button", { name: "Create identity" }).click();
  const grid = page.locator("ol.mnemonic-grid");
  const passwordField = page.locator('input[type="password"]').first();
  await Promise.race([grid.waitFor({ timeout: 30_000 }), passwordField.waitFor({ timeout: 30_000 })]);
  if (await passwordField.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.getByRole("button", { name: "Create identity" }).click();
    await grid.waitFor({ timeout: 30_000 });
  }
  await scan(page, `[en/${scheme}] recovery words`);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("navigation", { name: "Navigation" }).waitFor({ timeout: 20_000 });
  await scan(page, `[en/${scheme}] identity tab`);

  await page.getByRole("button", { name: "Contacts" }).click();
  await page.getByText("No verified contacts yet.", { exact: false }).waitFor({ timeout: 10_000 });
  await scan(page, `[en/${scheme}] contacts (empty)`);

  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: "Show my invitation" }).waitFor({ timeout: 10_000 });
  await scan(page, `[en/${scheme}] connect`);

  // Same screens in Bulgarian, switched on the page.
  await page.getByRole("button", { name: "Български" }).click();
  await page.getByRole("button", { name: "Покажи моята покана" }).waitFor({ timeout: 5_000 });
  // Let the switch's colour transition (180 ms) finish, so axe measures the settled colours.
  await page.waitForTimeout(400);
  await scan(page, `[bg/${scheme}] connect`);
  await page.getByRole("button", { name: "Контакти" }).click();
  await page.getByText("Още няма потвърдени контакти", { exact: false }).waitFor({ timeout: 10_000 });
  await scan(page, `[bg/${scheme}] contacts (empty)`);
  await page.getByRole("button", { name: "Идентичност" }).click();
  await page.getByRole("heading", { name: "Твоята идентичност" }).waitFor({ timeout: 10_000 });
  await scan(page, `[bg/${scheme}] identity tab`);

  await ctx.close();
} catch (err) {
  blocking++;
  console.log(`FAIL  run stopped: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
  await server.close();
}

if (warnings.length) {
  console.log(`\nWarnings (moderate or minor, not blocking):`);
  for (const w of warnings) console.log(`  ${w}`);
}
console.log(`\n${blocking === 0 ? "No serious or critical accessibility violations." : `${blocking} blocking finding(s).`}`);
process.exit(blocking ? 1 : 0);
