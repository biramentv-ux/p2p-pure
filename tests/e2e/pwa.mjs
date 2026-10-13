/**
 * PWA verification against the PRODUCTION build (vite build + vite preview)
 * in a real Chromium browser.
 *
 *   node tests/e2e/pwa.mjs
 *
 * Checks: manifest contents, service worker activation, controlled page,
 * offline app shell, manifest link and theme-color meta.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, preview } from "vite";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "../..");
const CHROME_PATH =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const HEADING = "Създай идентичност";

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const watchdog = setTimeout(() => {
  console.error("WATCHDOG: aborting after 180s");
  process.exit(2);
}, 180_000);
watchdog.unref();

await build({ root: ROOT, logLevel: "error" });
const server = await preview({
  root: ROOT,
  preview: { host: "127.0.0.1", port: 0, strictPort: false },
  logLevel: "error",
});
const base = server.resolvedUrls.local[0].replace(/\/$/, "");

const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox"],
});

let exitCode = 0;
try {
  // 1. Manifest file in dist
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(resolve(ROOT, "dist/manifest.webmanifest"), "utf8"));
  } catch {
    manifest = null;
  }
  check("manifest file exists in dist", manifest !== null);
  const icons = manifest?.icons ?? [];
  const has = (size) => icons.some((i) => i.sizes === size);
  check(
    "manifest fields (name, short_name, start_url, display, theme_color)",
    !!manifest?.name &&
      !!manifest?.short_name &&
      !!manifest?.start_url &&
      manifest?.display === "standalone" &&
      !!manifest?.theme_color,
    manifest ? `display=${manifest.display}` : "",
  );
  check(
    "manifest icons 192 and 512",
    has("192x192") && has("512x512"),
  );
  check(
    "manifest maskable icon",
    icons.some((i) => typeof i.purpose === "string" && i.purpose.includes("maskable")),
  );

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // 5. Manifest link and theme-color in the served HTML
  await page.goto(base + "/", { waitUntil: "load" });
  const head = await page.evaluate(() => ({
    manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? null,
    theme: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
  }));
  check(
    "manifest link and theme-color meta in index.html",
    !!head.manifestHref && !!head.theme,
    `manifest=${head.manifestHref} theme=${head.theme}`,
  );

  // 2. Service worker reaches 'activated'
  const swState = await page.evaluate(async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30_000)),
    ]);
    const sw = reg.active;
    if (sw && sw.state !== "activated") {
      await new Promise((res) => {
        sw.addEventListener("statechange", () => sw.state === "activated" && res());
        if (sw.state === "activated") res();
      });
    }
    return reg.active?.state ?? "none";
  }).catch((e) => `error: ${e.message}`);
  check("service worker activated within 30s", swState === "activated", swState);

  // 3. Page controlled after reload
  await page.reload({ waitUntil: "load" });
  const controlled = await page.evaluate(
    () => new Promise((res) => {
      if (navigator.serviceWorker.controller) return res(true);
      navigator.serviceWorker.addEventListener("controllerchange", () => res(true));
      setTimeout(() => res(false), 10_000);
    }),
  );
  check("page controlled by service worker after reload", controlled);

  // 4. Offline shell
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "load" });
  const offlineText = await page
    .locator("h1", { hasText: HEADING })
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const offlineRoot = await page.evaluate(() => document.getElementById("root")?.innerHTML.length ?? 0);
  check(
    `offline reload renders app shell ("${HEADING}")`,
    offlineText,
    `root bytes=${offlineRoot}`,
  );
  await ctx.setOffline(false);

  check(
    "no uncaught page errors",
    pageErrors.length === 0,
    pageErrors.slice(0, 2).join(" | "),
  );

  await ctx.close();
} catch (e) {
  console.error("ERROR:", e);
  exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(exitCode || (passed === results.length ? 0 : 1));
