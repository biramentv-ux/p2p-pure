/**
 * Linux desktop test: drives the Electron app (the installed .deb, or a checkout) with
 * Playwright. Checks what the messenger needs from its window, then the identity flow:
 *
 *   1. the page is a secure app:// origin with WebRTC, WebCrypto and IndexedDB;
 *   2. a real RTCDataChannel carries a message between two peers inside the window;
 *   3. a page cannot navigate away, open windows, or get permissions other than camera/mic;
 *   4. an identity is created (password, as there is no passkey on a CI machine), the app is
 *      restarted, and unlocking with the password gives back the same identity (storage
 *      survives restarts); a wrong password is refused.
 *
 *   Installed:  APP_BIN=/opt/P2P\ Messenger/p2p-messenger node tests/desktop/electron-linux.mjs
 *   Checkout:   npm run build:desktop && (cd electron && npm ci) && node tests/desktop/electron-linux.mjs
 * Env: APP_BIN, OUT_DIR (default desktop-test), NO_SANDBOX=1 (root in a container only).
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT = resolve(process.env.OUT_DIR ?? "desktop-test");
const PASSWORD = "linux parola 2026";
const IS_CI = Boolean(process.env.GITHUB_ACTIONS);
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "p2p-electron-"));

const APP_BIN = process.env.APP_BIN;
const dev = resolve("electron/node_modules/electron/dist/electron");
if (!APP_BIN && !existsSync(dev)) {
  console.error("Set APP_BIN (installed app) or run npm ci in electron/ first.");
  process.exit(2);
}

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => {
  console.error("watchdog: electron test aborted after 240 s");
  process.exit(2);
}, 240_000).unref();

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (IS_CI && !ok) console.log(`::error title=${name}::${detail}`);
}

const PORT = 9333;
/**
 * Starts the app and attaches over the Chromium DevTools port. The shipped app has the Node.js
 * inspector fuse switched off, so Playwright's own Electron launcher (which needs it) is not
 * used: the test must run against the very binary users get.
 */
async function launch() {
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`];
  if (process.env.NO_SANDBOX) args.push("--no-sandbox");
  const child = spawn(APP_BIN ?? dev, APP_BIN ? args : [...args, resolve("electron/main.mjs")], { stdio: "ignore", detached: true });
  let exited = false;
  child.on("exit", () => (exited = true));
  let browser = null;
  for (let i = 0; i < 100 && !browser; i++) {
    if (exited) throw new Error("the app exited before its window opened");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 300));
  }
  if (!browser) throw new Error("could not attach to the app");
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));
  await page.waitForSelector("main", { timeout: 30_000 });
  const app = {
    async close() {
      await browser.close().catch(() => {});
      // The whole group: an AppImage starts the app as a child of its launcher.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      if (!exited) await new Promise((r) => (child.once("exit", r), setTimeout(r, 5000)));
    },
  };
  return { app, page };
}

const state = (page) =>
  page.evaluate(() => {
    if (document.querySelector("ol.mnemonic-grid")) return "mnemonic";
    if (document.querySelector('input[autocomplete="current-password"]')) return "unlock-password";
    if (document.querySelector('input[type="password"]')) return "create-password";
    if (document.querySelector(".did-text")) return "main";
    return "other";
  });

async function waitState(page, wanted, ms = 45_000) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = await state(page).catch(() => "evaluating");
    if (wanted.includes(last)) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`expected ${wanted.join("|")}, still on "${last}"`);
}

// ------------------------------------------------------------------ first run
let { app, page } = await launch();
try {
  const caps = await page.evaluate(() => ({
    origin: location.origin,
    secure: window.isSecureContext,
    webrtc: typeof RTCPeerConnection,
    webauthn: typeof PublicKeyCredential,
    subtle: Boolean(crypto?.subtle),
    idb: typeof indexedDB,
    node: typeof require + typeof process,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null,
  }));
  log(`caps ${JSON.stringify(caps)}`);
  check("origin is app://p2p and a secure context", caps.origin === "app://p2p" && caps.secure);
  check("WebRTC, WebCrypto, IndexedDB are there", caps.webrtc === "function" && caps.subtle && caps.idb === "object");
  check("no Node.js inside the page", caps.node === "undefinedundefined");
  check("page keeps its Content-Security-Policy", caps.csp);

  const dc = await page.evaluate(async () => {
    try {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      const ch = a.createDataChannel("t");
      const got = new Promise((res) => {
        b.ondatachannel = (e) => (e.channel.onmessage = (m) => res(m.data));
      });
      ch.onopen = () => ch.send("ping");
      await a.setLocalDescription(await a.createOffer());
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer());
      await a.setRemoteDescription(b.localDescription);
      const v = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))]);
      return { ok: v === "ping" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  check("a data channel carries a message", dc.ok, dc.error ?? "");

  // Isolation: the shell refuses what a page must never be able to do.
  const escape = await page.evaluate(async () => {
    const out = {};
    out.opened = window.open("https://example.org/") === null;
    const res = await fetch("app://p2p/../../etc/passwd").then((r) => r.status).catch(() => "error");
    out.traversal = res;
    out.other = await fetch("app://evil/index.html").then((r) => r.status).catch(() => "error");
    const perm = await navigator.permissions.query({ name: "geolocation" }).then((p) => p.state).catch(() => "error");
    out.geo = perm;
    return out;
  });
  log(`isolation ${JSON.stringify(escape)}`);
  check("window.open is refused", escape.opened);
  check("path traversal and other hosts are refused", escape.traversal !== 200 && escape.other !== 200);
  check("geolocation is not granted", escape.geo !== "granted");
  const before = page.url();
  await page.evaluate(() => {
    location.href = "https://example.org/";
  });
  await page.waitForTimeout(1500);
  check("navigation away is blocked", page.url() === before, page.url());
  // A blocked navigation leaves the test driver waiting for a load that never comes.
  await page.goto(before);
  await page.waitForSelector("main", { timeout: 30_000 });

  // Identity: password (no passkey on a CI machine).
  await page.locator("main > .screen > button").first().click();
  const first = await waitState(page, ["mnemonic", "create-password"], 60_000).catch(async (e) => { await page.screenshot({ path: join(OUT, "electron-create.png") }); console.log("BODY", (await page.locator("main").innerText()).slice(0, 400)); throw e; });
  if (first === "create-password") {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await waitState(page, ["mnemonic"], 60_000);
  }
  const words = await page.locator("ol.mnemonic-grid li").count();
  await page.locator('main > .screen input[type="checkbox"]').check();
  await page.locator("main > .screen > button").first().click();
  await waitState(page, ["main"]);
  const did = (await page.locator(".did-text").innerText()).trim();
  check("identity created (12 words, did:key)", words === 12 && did.startsWith("did:key:z6Mk"), `${words} words, ${did.slice(0, 20)}…`);
  await page.screenshot({ path: join(OUT, "electron-main.png") });
  await app.close();

  // ------------------------------------------------------------------ restart
  ({ app, page } = await launch());
  const st = await waitState(page, ["unlock-password", "main"]);
  check("after a restart the app asks to unlock", st === "unlock-password", st);
  if (st === "unlock-password") {
    await page.locator('input[autocomplete="current-password"]').fill("грешна парола");
    await page.locator("main > form.screen button[type=submit]").click();
    await page.waitForTimeout(2500);
    check("a wrong password is refused", (await state(page)) === "unlock-password");
    await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
    await page.locator("main > form.screen button[type=submit]").click();
    await waitState(page, ["main"]);
    const again = (await page.locator(".did-text").innerText()).trim();
    check("same identity after the restart", again === did);
  }
} catch (err) {
  failures++;
  console.error("FAILED", err);
  await page?.screenshot({ path: join(OUT, "electron-failed.png") }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
}
log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
