/**
 * Android emulator QA driver. Runs against a booted emulator/device that already has
 * the debug APK installed (see .github/workflows/android-emulator.yml).
 *
 *   node tests/mobile/android-emulator.mjs
 *
 * Talks to the app WebView through Playwright's Android support (adb) (WebView debugging is
 * on only in debug builds: Capacitor defaults android.webContentsDebuggingEnabled to
 * BuildConfig.DEBUG). Env: ADB (default "adb"), APP_ID, OUT_DIR (default "emulator-artifacts").
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { _android as android } from "playwright-core";

const ADB = process.env.ADB ?? "adb";
const APP_ID = process.env.APP_ID ?? "bg.p2pmessenger.app";
const OUT = process.env.OUT_DIR ?? "emulator-artifacts";
const PORT = 9222;
const PASSWORD = "emulator-test-pass-123";
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
  // Run logs and artifacts are not always readable from outside; annotations are.
  if (process.env.GITHUB_ACTIONS) {
    const esc = (t) => String(t).slice(0, 900).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::${ok ? "notice" : "error"} title=${esc(name)}::${esc(detail || (ok ? "ok" : "failed"))}`);
  }
}
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function screencap(name) {
  try {
    const png = execFileSync(ADB, ["exec-out", "screencap", "-p"], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(`${OUT}/${name}.png`, png);
  } catch (e) {
    console.log(`screencap ${name} failed: ${e.message}`);
  }
}

function launch() {
  adb("shell", "am", "force-stop", APP_ID);
  adb("shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1");
}

/** Find the WebView devtools socket of the app and forward it to a local port. */
async function forward() {
  for (let i = 0; i < 40; i++) {
    // pidof exits 1 while the app is still starting: that is "not yet", not an error.
    let pid = "";
    try {
      pid = adb("shell", "pidof", APP_ID).trim().split(/\s+/)[0];
    } catch {
      pid = "";
    }
    if (pid) {
      const sockets = adb("shell", "cat", "/proc/net/unix");
      if (sockets.includes(`webview_devtools_remote_${pid}`)) {
        adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
        return;
      }
    }
    await sleep(1500);
  }
  let running = "";
  try {
    running = adb("shell", "pidof", APP_ID).trim();
  } catch {
    running = "";
  }
  throw new Error(running ? "WebView devtools socket not found (is this a debug build?)" : `${APP_ID} is not running after launch`);
}

/**
 * Attaches to the app's WebView with Playwright's Android support. A plain connectOverCDP
 * does not work here: an Android WebView rejects the browser-level commands Playwright sends
 * (Browser.setDownloadBehavior, "Browser context management is not supported").
 */
async function connect(errors) {
  await forward(); // waits until the app runs and its WebView devtools socket exists
  const [device] = await android.devices();
  if (!device) throw new Error("no Android device visible to adb");
  const webview = await device.webView({ pkg: APP_ID }, { timeout: 60000 });
  const page = await webview.page();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
  await page.waitForLoadState("domcontentloaded");
  return { browser: { close: () => device.close() }, page };
}

/** The app follows the system language (English on a fresh emulator); the test uses Bulgarian names. */
const bulgarian = (page) => page.getByRole("button", { name: /^БГ/ }).first().click({ timeout: 5000 }).catch(() => {});

async function readDid(page) {
  const loc = page.locator(".did-text").first();
  if (!(await loc.count())) {
    const qr = page.getByText(/QR|Покажи/i).first();
    if (await qr.count()) await qr.click().catch(() => {});
  }
  await page.locator(".did-text").first().waitFor({ timeout: 20000 });
  return (await page.locator(".did-text").first().innerText()).trim();
}

let browser;
let page;
const errors = [];
try {
  adb("wait-for-device");
  launch();
  ({ browser, page } = await connect(errors));
  await page.waitForSelector("#root *", { timeout: 30000 });
  check("app starts", true, await page.title());
  screencap("01-launch");

  const env = await page.evaluate(async () => ({
    rtc: typeof RTCPeerConnection === "function",
    subtle: !!(globalThis.crypto && crypto.subtle),
    idb: typeof indexedDB === "object" && indexedDB !== null,
    secure: isSecureContext,
    digest: await crypto.subtle
      .digest("SHA-256", new Uint8Array([1]))
      .then((b) => b.byteLength === 32)
      .catch(() => false),
    ua: navigator.userAgent,
  }));
  check("RTCPeerConnection present", env.rtc);
  check("crypto.subtle works", env.subtle && env.digest, `secureContext=${env.secure}`);
  check("IndexedDB present", env.idb);

  await bulgarian(page);
  // Create identity via the password path.
  await page.getByRole("button", { name: "Създай идентичност" }).first().click();
  const withPw = page.getByRole("button", { name: "Продължи с парола" });
  const pwField = page.locator('input[type="password"]').first();
  await Promise.race([
    withPw.waitFor({ timeout: 20000 }).catch(() => {}),
    pwField.waitFor({ timeout: 20000 }).catch(() => {}),
  ]);
  if (await withPw.count()) await withPw.click();
  await pwField.waitFor({ timeout: 15000 });
  const fields = page.locator('input[type="password"]');
  await fields.nth(0).fill(PASSWORD);
  await fields.nth(1).fill(PASSWORD);
  screencap("02-password");
  await page.locator('form button[type="submit"]').click();
  await page.locator('input[type="checkbox"]').waitFor({ timeout: 60000 });
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Продължи", exact: true }).click();
  const did1 = await readDid(page);
  check("identity created (did:key)", /^did:key:z6Mk/.test(did1), did1);
  screencap("03-identity");

  // Restart, unlock, same DID.
  await browser.close().catch(() => {});
  launch();
  ({ browser, page } = await connect(errors));
  await page.locator('input[type="password"]').first().waitFor({ timeout: 30000 });
  screencap("04-locked");
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type="submit"]').click();
  const did2 = await readDid(page);
  check("unlock after restart gives same DID", did1 === did2, did2);
  screencap("05-unlocked");
} catch (e) {
  check("driver completed", false, e.stack ?? String(e));
  screencap("error");
} finally {
  await browser?.close().catch(() => {});
}

check("no JS errors", errors.length === 0, errors.slice(0, 5).join(" | "));
writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
