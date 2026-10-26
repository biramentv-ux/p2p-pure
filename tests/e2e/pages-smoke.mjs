/**
 * The production build served under a sub-path, the way GitHub Pages serves it
 * (https://<user>.github.io/p2p-pure/). Builds with BASE_PATH, serves dist/ with vite preview,
 * and checks that the app starts, a profile can be created and the service worker takes the
 * sub-path scope.
 *
 *   npm run test:pages
 */
import { spawnSync } from "node:child_process";
import { preview } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const BASE = "/p2p-pure/";
const PASSWORD = "dolga parola 2026";

setTimeout(() => {
  console.error("WATCHDOG: aborting after 240s");
  process.exit(2);
}, 240_000).unref();

const build = spawnSync("npx", ["vite", "build", "--logLevel", "error"], {
  stdio: "inherit",
  env: { ...process.env, BASE_PATH: BASE },
});
if (build.status !== 0) process.exit(build.status ?? 1);

process.env.BASE_PATH = BASE;
const server = await preview({ preview: { port: 0, host: "localhost" }, logLevel: "error" });
const origin = server.resolvedUrls.local[0].replace(/\/p2p-pure\/?$/, "").replace(/\/$/, "");
const url = origin + BASE;

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

try {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const page = await ctx.newPage();
  const errors = [];
  const missing = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
  });

  // Virtual authenticator without PRF: the app falls back to a password, as in tests/e2e/ui.mjs.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });

  await page.goto(url);
  const create = page.getByRole("button", { name: "Създай идентичност" });
  await create.waitFor({ timeout: 30_000 });
  check("app starts under " + BASE, true);

  // Create a profile: proves the bundle, IndexedDB and crypto run from the sub-path.
  await create.click();
  const passwordForm = page.locator('input[type="password"]').first();
  const grid = page.locator("ol.mnemonic-grid");
  await Promise.race([passwordForm.waitFor({ timeout: 30_000 }), grid.waitFor({ timeout: 30_000 })]);
  if (await passwordForm.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await grid.waitFor({ timeout: 30_000 });
  }
  check("a profile can be created", true);

  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg?.scope ?? null;
  });
  check("service worker is scoped to the sub-path", !!scope && new URL(scope).pathname === BASE, String(scope));

  const manifest = await (await page.request.get(url + "manifest.webmanifest")).json();
  check("manifest start_url and scope point at the sub-path", manifest.start_url === BASE && manifest.scope === BASE);

  check("no missing files", missing.length === 0, missing.slice(0, 3).join(", "));
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("run completed without exception", false, e.message.split("\n")[0]);
} finally {
  await browser.close();
  await server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
