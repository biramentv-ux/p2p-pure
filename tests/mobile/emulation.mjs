/**
 * Virtual device tests. Runs the real app in Playwright with phone profiles and, for
 * the native path, a stubbed Capacitor runtime (no device, no Android SDK, no Xcode).
 *
 *   npm run test:mobile-emu
 *
 * Checks:
 *  1. Layout on an iPhone and a Pixel profile: no horizontal scroll, viewport meta,
 *     primary button at least 44px tall (touch target).
 *  2. Android native path: the app calls the PasskeyBridge plugin with rp.id equal to
 *     the configured domain, not "localhost" (the WebView host).
 */
import { createServer } from "vite";
import { chromium, devices } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const RP_ID = "dyrakarmy.online";
process.env.VITE_PASSKEY_RP_ID = RP_ID;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox"],
});

/**
 * Capacitor runtime stub. The core library replaces window.Capacitor on load and reads
 * getPlatform from the native bridge object, so the platform is faked with androidBridge
 * before load. The plugin's methods come from PluginHeaders and the call goes through
 * nativePromise, which the test replaces after load (it looks it up on each call).
 */
const ANDROID_INIT = "window.androidBridge = { postMessage() {} };";

async function stubNativePlugin(page) {
  await page.evaluate(() => {
    window.__nativeCalls = [];
    window.Capacitor.PluginHeaders = [
      {
        name: "PasskeyBridge",
        methods: [
          { name: "create", rtype: "promise" },
          { name: "get", rtype: "promise" },
        ],
      },
    ];
    window.Capacitor.nativePromise = (plugin, method, opts) => {
      window.__nativeCalls.push({ plugin, method, opts });
      // Refuse the call: the test checks what the app sends to the native side.
      return Promise.reject(new Error("stub: native passkeys not available in emulation"));
    };
  });
}

async function openDevice(profile, extraInit) {
  const ctx = await browser.newContext({ ...devices[profile] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (extraInit) await page.addInitScript(extraInit);
  await page.goto(base + "/");
  await page.getByRole("button", { name: "Създай идентичност" }).waitFor({ timeout: 30_000 });
  return { ctx, page, errors };
}

try {
  for (const profile of ["iPhone 13", "Pixel 7"]) {
    const { ctx, page, errors } = await openDevice(profile);
    const metrics = await page.evaluate(() => ({
      vw: document.documentElement.clientWidth,
      sw: document.documentElement.scrollWidth,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
      btnH: Math.min(
        ...[...document.querySelectorAll("button")]
          .filter((b) => b.offsetParent !== null)
          .map((b) => b.getBoundingClientRect().height),
      ),
    }));
    check(`${profile}: no horizontal scroll`, metrics.sw <= metrics.vw, `scrollWidth=${metrics.sw} clientWidth=${metrics.vw}`);
    check(`${profile}: viewport meta set`, /width=device-width/.test(metrics.viewport), metrics.viewport);
    check(`${profile}: buttons at least 44px tall`, metrics.btnH >= 44, `min=${Math.round(metrics.btnH)}px`);
    check(`${profile}: no page errors on load`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // Native path: the Android WebView origin is localhost, so the rpId must come from config.
  const { ctx, page, errors } = await openDevice("Pixel 7", ANDROID_INIT);
  await stubNativePlugin(page);
  await page.getByRole("button", { name: "Създай идентичност" }).click();
  // Passkey path asks for a create; if the app shows a password form first, go through it.
  const pwd = page.locator('input[type="password"]').first();
  if (await pwd.isVisible().catch(() => false)) {
    await page.locator('input[type="password"]').nth(0).fill("dolga parola 2026");
    await page.locator('input[type="password"]').nth(1).fill("dolga parola 2026");
    await page.locator("form button[type=submit]").click();
  }
  await page.waitForFunction(() => window.__nativeCalls.some((c) => c.method === "create"), null, { timeout: 30_000 }).catch(() => {});
  const calls = await page.evaluate(() => window.__nativeCalls);
  const create = calls.find((c) => c.plugin === "PasskeyBridge" && c.method === "create");
  check("android: passkey create goes to the PasskeyBridge plugin", !!create, JSON.stringify(calls.map((c) => c.method)));
  if (create) {
    const req = JSON.parse(create.opts.requestJson);
    check(`android: rp.id is ${RP_ID}, not localhost`, req.rp?.id === RP_ID, `rp.id=${req.rp?.id}`);
  }
  await ctx.close();
  void errors;
} catch (err) {
  check("emulation run completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
