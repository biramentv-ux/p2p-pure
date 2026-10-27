/**
 * Desktop identity test: drives the INSTALLED Windows app (Tauri 2 + WebView2) through
 * the Chrome DevTools Protocol. There is no Windows Hello on a CI runner, so a CDP
 * virtual authenticator stands in for it:
 *
 *   1. passkey with PRF  -> create identity, lock (reload), unlock with the passkey,
 *                           restart the app, identity still there, unlock again;
 *   2. passkey without PRF -> the app must fall back to a device password: create,
 *                           wrong password rejected, unlock, restart, unlock again;
 *   3. passkey refused (like a cancelled Windows Hello prompt) -> the app must offer a
 *                           password and create the identity with it;
 *   4. Windows Hello unlock commands (Tauri): status answers, foreign names and bad challenges
 *                           are refused, other Tauri commands are blocked by the capability,
 *                           and with Hello unavailable (CI) the method stays hidden (INFO).
 *
 * Facts (origin, secure context, WebAuthn availability, unlock method, persistence) are
 * printed as GitHub annotations, because run logs are not always readable from outside.
 * Real WebView2 limitations are reported, app errors fail the step.
 *
 * Windows CI:  APP_EXE="%LOCALAPPDATA%\P2P Messenger\p2p-messenger.exe" node tests/desktop/webview2-identity.mjs
 * Local check of the same bundle in Chromium (npm run build:desktop first):
 *              LOCAL_DIST=dist node tests/desktop/webview2-identity.mjs
 */
import { chromium } from "playwright-core";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { tmpdir } from "node:os";

const PORT = 9222;
const CDP = `http://127.0.0.1:${PORT}`;
const PASSWORD = "desktop parola 2026";
const OUT_DIR = resolve(process.env.OUT_DIR ?? "desktop-test");
const APP_EXE = process.env.APP_EXE;
const LOCAL_DIST = process.env.LOCAL_DIST;
const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const IS_CI = Boolean(process.env.GITHUB_ACTIONS);
// "config": APP_EXE is a build whose window config already opens the port (additionalBrowserArgs).
const DEVTOOLS_VIA = process.env.DEVTOOLS_VIA;

if (!APP_EXE && !LOCAL_DIST) {
  console.error("Set APP_EXE (installed Windows app) or LOCAL_DIST (built web bundle).");
  process.exit(2);
}
mkdirSync(OUT_DIR, { recursive: true });

const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => {
  annotate("error", "webview2-watchdog", "identity test aborted after 300 s");
  process.exit(2);
}, 300_000).unref();

/** GitHub workflow command, escaped so newlines and % survive. */
function annotate(level, title, message) {
  const esc = String(message).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (IS_CI) console.log(`::${level} title=${title}::${esc}`);
  else console.log(`${level.toUpperCase()} ${title}: ${message}`);
}

const checks = [];
/** fatal=false: a known limitation, reported but not failing the build. */
function check(name, ok, detail = "", fatal = true) {
  checks.push({ name, ok, detail, fatal });
  log(`${ok ? "PASS" : fatal ? "FAIL" : "INFO"}  ${name}${detail ? "  — " + detail : ""}`);
  return ok;
}

// ---------------------------------------------------------------- app process

let current = null; // { child, browser, page, errors, consoleErrors, cdp }
let staticServer = null;
let localProfile = null;

function startStaticServer(dir) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm", ".json": "application/json" };
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = join(dir, path);
      if (!file.startsWith(resolve(dir)) || !existsSync(file) || path.endsWith("/")) file = join(dir, "index.html");
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => ok(server));
  });
}

async function cdpUp() {
  try {
    const r = await fetch(`${CDP}/json/version`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** WebView2 browser processes and their command lines (Windows), for diagnostics. */
function webviewProcesses() {
  if (!APP_EXE) return Promise.resolve("");
  const ps =
    "Get-CimInstance Win32_Process -Filter \"name='msedgewebview2.exe'\" | " +
    "Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { \"$($_.ProcessId): $($_.CommandLine)\" }";
  return new Promise((ok) =>
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 20_000 }, (_e, out) => ok(String(out ?? "").trim())),
  );
}

/** A WebView2 browser left from an earlier start would be reused, and it ignores new arguments. */
async function killLeftoverWebView2() {
  if (!APP_EXE) return;
  await new Promise((r) => execFile("taskkill", ["/IM", "msedgewebview2.exe", "/T", "/F"], () => r()));
}

const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 20_000 }, (e, out) => ok(e ? null : out)));
const DEBUG_ARG = `--remote-debugging-port=${PORT}`;
const POLICY_KEY = "HKCU\\Software\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments";
let debugVia = null; // how the DevTools port was opened (see spawnWindowsApp)
let policySet = false;

/**
 * Starts the app with the WebView2 DevTools port open. WebView2 documents three ways that
 * need no change to the app: the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS variable, the host
 * switch --edge-webview-switches, and the per-app registry value under
 * Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments (read only when no
 * variable is set). The first one that works is kept for the restarts.
 */
async function spawnWindowsApp(via) {
  const env = { ...process.env };
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  const args = [];
  if (via === "env") env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = DEBUG_ARG;
  if (via === "switch") args.push(`--edge-webview-switches=${DEBUG_ARG}`);
  if (via === "config") return spawn(APP_EXE, [], { env, stdio: "ignore" });
  if (via === "registry" && !policySet) {
    const name = APP_EXE.split(/[\\/]/).pop();
    for (const value of [name, "*"]) await run("reg", ["add", POLICY_KEY, "/v", value, "/t", "REG_SZ", "/d", DEBUG_ARG, "/f"]);
    policySet = true;
  }
  return spawn(APP_EXE, args, { env, stdio: "ignore" });
}

async function launchApp() {
  if (await cdpUp()) throw new Error(`port ${PORT} is already in use before launch`);
  await killLeftoverWebView2();
  let child, exited, version;
  if (APP_EXE) {
    const ways = debugVia ? [debugVia] : DEVTOOLS_VIA ? [DEVTOOLS_VIA] : ["env", "switch", "registry"];
    for (const via of ways) {
      child = await spawnWindowsApp(via);
      exited = new Promise((r) => child.once("exit", (code) => r(code)));
      try {
        version = await Promise.race([
          waitFor(cdpUp, 25_000, `the WebView2 DevTools endpoint (${via})`),
          exited.then((code) => { throw new Error(`app exited during start (code ${code})`); }),
        ]);
        debugVia = via;
        break;
      } catch (err) {
        const procs = await webviewProcesses();
        annotate(
          "warning",
          `webview2-debug-${via}`,
          `${err.message}. host pid ${child.pid}. ${procs ? procs.slice(0, 2000) : "no msedgewebview2.exe browser process"}`,
        );
        if (via === "registry") {
          const policies = [
            await run("reg", ["query", "HKCU\\Software\\Policies\\Microsoft\\Edge", "/s"]),
            await run("reg", ["query", "HKLM\\Software\\Policies\\Microsoft\\Edge", "/s"]),
          ].map((o) => (o ?? "(none)").trim().replace(/\s+/g, " ").slice(0, 1200));
          annotate("warning", "webview2-policies", `HKCU: ${policies[0]} || HKLM: ${policies[1]}`);
        }
        await run("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        await exited;
        await killLeftoverWebView2();
        if (via === ways[ways.length - 1]) {
          // None of the ways opened the port: the installed app cannot be driven at all.
          throw Object.assign(new Error(`WebView2 DevTools port did not open (${ways.join(", ")})`), { noDevtools: true });
        }
      }
    }
  } else {
    staticServer ??= await startStaticServer(resolve(LOCAL_DIST));
    localProfile ??= mkdtempSync(join(tmpdir(), "webview2-identity-"));
    const url = `http://tauri.localhost:${staticServer.address().port}/`;
    child = spawn(CHROME_PATH, [
      "--headless=new", "--no-sandbox", "--no-first-run", DEBUG_ARG,
      `--user-data-dir=${localProfile}`, "--window-size=480,860", url,
    ], { stdio: "ignore" });
    exited = new Promise((r) => child.once("exit", (code) => r(code)));
    version = await waitFor(cdpUp, 60_000, "the DevTools endpoint");
  }
  const browser = await chromium.connectOverCDP(CDP);
  const page = await waitFor(async () => {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) if (/^https?:\/\/tauri\.localhost/.test(p.url())) return p;
    }
    return null;
  }, 30_000, "the app page at tauri.localhost");
  const errors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const cdp = await page.context().newCDPSession(page);
  current = { child, exited, browser, page, errors, consoleErrors, cdp, version };
  await page.waitForLoadState("domcontentloaded");
  return current;
}

/** Closes the window like a user would (WM_CLOSE), forcing only if it does not exit. */
async function closeApp() {
  const { child, exited, page, errors, consoleErrors } = current;
  allPageErrors.push(...errors);
  allConsoleErrors.push(...consoleErrors);
  let how = "graceful";
  if (APP_EXE) {
    await new Promise((r) => execFile("taskkill", ["/PID", String(child.pid)], () => r()));
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") {
      how = "forced";
      await new Promise((r) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => r()));
      await exited;
    }
  } else {
    await page.close().catch(() => undefined);
    child.kill("SIGTERM");
    await exited;
  }
  // The WebView2 browser processes exit after the host; wait until the port is free.
  await waitFor(async () => !(await cdpUp()), 30_000, "WebView2 to shut down");
  current = null;
  return how;
}

const allPageErrors = [];
const allConsoleErrors = [];

// ---------------------------------------------------------------- page helpers

/** Which identity screen is showing, from the DOM structure (works in bg and en). */
function screenState(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    if (q("nav.tabs")) return q(".did-text") ? "main" : "main-other";
    if (q("ol.mnemonic-grid")) return "mnemonic";
    if (q('input[autocomplete="new-password"]')) return "create-password";
    if (q('input[autocomplete="current-password"]')) return "unlock-password";
    if (q("ul.chips")) return "create";
    if (q("main > .screen button")) return "unlock-passkey";
    return "loading";
  });
}

async function waitState(page, wanted, timeoutMs = 30_000) {
  const set = Array.isArray(wanted) ? wanted : [wanted];
  let last = "";
  try {
    return await waitFor(async () => {
      last = await screenState(page).catch(() => "evaluating");
      return set.includes(last) ? last : null;
    }, timeoutMs, set.join("|"));
  } catch {
    throw new Error(`expected screen ${set.join("|")}, still on "${last}"`);
  }
}

const alertText = (page) =>
  page.evaluate(() => document.querySelector('main [role="alert"]')?.textContent?.trim() ?? "");

/** The stored identity record, read straight from IndexedDB (no secrets: method, did). */
function storedRecord(page) {
  return page.evaluate(
    () =>
      new Promise((ok) => {
        const req = indexedDB.open("p2p-messenger");
        req.onerror = () => ok({ error: String(req.error) });
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("identity")) {
            db.close();
            return ok(null);
          }
          const get = db.transaction("identity", "readonly").objectStore("identity").get("current");
          get.onsuccess = () => {
            const r = get.result;
            db.close();
            ok(r ? { did: r.did, unlockMethod: r.unlockMethod, hasCredentialId: Boolean(r.credentialId) } : null);
          };
          get.onerror = () => {
            db.close();
            ok({ error: String(get.error) });
          };
        };
      }),
  );
}

async function wipeIdentity(page) {
  await page.evaluate(
    () =>
      new Promise((ok) => {
        const req = indexedDB.deleteDatabase("p2p-messenger");
        req.onsuccess = req.onerror = req.onblocked = () => ok();
      }),
  );
  await page.reload();
}

/** userVerified=false: the authenticator refuses, like a cancelled Windows Hello prompt. */
async function addAuthenticator(cdp, hasPrf, userVerified = true) {
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: userVerified,
      automaticPresenceSimulation: true,
      hasPrf,
    },
  });
  return authenticatorId;
}

/** Create button -> mnemonic (passkey) or password form (no PRF), or an error on the intro screen. */
async function clickCreate(page) {
  await page.locator("main > .screen > button").first().click();
  return waitState(page, ["mnemonic", "create-password", "create"], 45_000).then(async (s) => {
    if (s !== "create") return s;
    // Still on the intro: either busy or an error was shown.
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      const st = await screenState(page);
      if (st !== "create") return st;
      const alert = await alertText(page);
      const busy = await page.locator("main > .screen > button").first().isDisabled();
      if (alert && !busy) return `error: ${alert}`;
      await page.waitForTimeout(300);
    }
    return "create (no reaction)";
  });
}

async function confirmMnemonic(page) {
  const words = await page.locator("ol.mnemonic-grid li").count();
  await page.locator('main > .screen input[type="checkbox"]').check();
  await page.locator("main > .screen > button").first().click();
  await waitState(page, "main");
  const did = (await page.locator(".did-text").innerText()).trim();
  return { words, did };
}

async function unlockWithPassword(page, password) {
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator("main > form.screen button[type=submit]").click();
}

/** Clicks the passkey unlock button and waits for the main screen or a shown error. */
async function unlockWithPasskey(page) {
  await page.locator("main > .screen > button").first().click();
  return waitFor(async () => {
    const st = await screenState(page).catch(() => "evaluating");
    if (st === "main") return { did: (await page.locator(".did-text").innerText()).trim() };
    if (st !== "unlock-passkey") return null;
    const alert = await alertText(page);
    const busy = await page.locator("main > .screen > button").first().isDisabled().catch(() => true);
    return alert && !busy ? { error: alert } : null;
  }, 45_000, "passkey unlock to finish");
}

async function mainDid(page) {
  await waitState(page, "main", 45_000);
  return (await page.locator(".did-text").innerText()).trim();
}

/** JPEG of the window, small enough for the annotation chunks (<= ~27 000 base64 chars). */
async function screenshot(cdp, page, name) {
  // Let the screen's entrance animation finish and the QR canvas draw.
  await page.locator("main canvas").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  let data = "";
  let used = null;
  for (const [scale, quality] of [[0.6, 50], [0.5, 40], [0.45, 30], [0.4, 22]]) {
    ({ data } = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip: { x: 0, y: 0, width: size.w, height: size.h, scale },
    }));
    used = { scale, quality };
    if (data.length <= 27_000) break;
  }
  const file = join(OUT_DIR, `${name}.jpg`);
  writeFileSync(file, Buffer.from(data, "base64"));
  log(`screenshot ${file} (${size.w}x${size.h} scale=${used.scale} q=${used.quality}, ${data.length} b64 chars)`);
  return file;
}

// ---------------------------------------------------------------- the run

const facts = {};
let fatalError = null;

try {
  // ---- launch 1: environment facts, then passkey with PRF
  let app = await launchApp();
  let { page, cdp } = app;
  facts.browser = app.version.Browser;
  facts.userAgent = app.version["User-Agent"];
  await waitState(page, ["create", "unlock-passkey", "unlock-password", "main"], 30_000);
  facts.env = await page.evaluate(async () => {
    const pkc = typeof window.PublicKeyCredential !== "undefined";
    let uvpaa = null;
    let caps = null;
    try {
      uvpaa = pkc ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : null;
    } catch (e) {
      uvpaa = `error: ${e.name}`;
    }
    try {
      caps = pkc && PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : null;
    } catch (e) {
      caps = `error: ${e.name}`;
    }
    return {
      origin: location.origin,
      href: location.href,
      isSecureContext: window.isSecureContext,
      navigatorCredentials: typeof navigator.credentials !== "undefined" && typeof navigator.credentials?.create === "function",
      publicKeyCredential: pkc,
      platformAuthenticator: uvpaa,
      clientCapabilities: caps,
      indexedDB: typeof indexedDB !== "undefined",
      language: navigator.language,
    };
  });
  const e = facts.env;
  const prfCap = e.clientCapabilities && typeof e.clientCapabilities === "object" ? e.clientCapabilities["extension:prf"] : undefined;
  annotate(
    "notice",
    "webview2-env",
    `app=${DEVTOOLS_VIA === "config" ? "test build with additionalBrowserArgs" : APP_EXE ? "installed" : "local"} ` +
      `devtools=${debugVia ?? "local"} origin=${e.origin} secureContext=${e.isSecureContext} navigator.credentials=${e.navigatorCredentials} ` +
      `PublicKeyCredential=${e.publicKeyCredential} platformAuthenticator(Windows Hello)=${e.platformAuthenticator} ` +
      `clientCapabilities.prf=${prfCap ?? "n/a"} indexedDB=${e.indexedDB} lang=${e.language} browser=${facts.browser}`,
  );
  if (APP_EXE) check("page origin is http://tauri.localhost", e.origin === "http://tauri.localhost", e.origin);
  check("secure context", e.isSecureContext === true, String(e.isSecureContext));
  check("IndexedDB available", e.indexedDB === true);

  // The smoke test already started the app once; make sure no identity is left from it.
  if ((await screenState(page)) !== "create") await wipeIdentity(page);
  await waitState(page, "create");

  // ---- scenario 1: passkey with PRF
  const webauthnOk = e.navigatorCredentials && e.publicKeyCredential;
  let prfAuth = null;
  facts.prf = {};
  if (webauthnOk) {
    prfAuth = await addAuthenticator(cdp, true);
    const outcome = await clickCreate(page);
    facts.prf.createOutcome = outcome;
    const rec = await storedRecord(page);
    facts.prf.storedMethod = rec?.unlockMethod ?? null;
    if (outcome === "mnemonic") {
      const { words, did } = await confirmMnemonic(page);
      facts.prf.did = did;
      check("PRF passkey: identity created with the passkey", rec?.unlockMethod === "webauthn-prf", `method=${rec?.unlockMethod}`);
      check("PRF passkey: 12 recovery words shown, did:key on the main screen", words === 12 && did.startsWith("did:key:z6Mk"), `${words} words, ${did.slice(0, 24)}…`);
      await page.reload(); // locks: the identity lives only in memory
      const locked = await waitState(page, ["unlock-passkey", "unlock-password", "create"]);
      check("PRF passkey: reload shows the passkey unlock screen", locked === "unlock-passkey", locked);
      if (locked === "unlock-passkey") {
        const r = await unlockWithPasskey(page);
        facts.prf.unlockAfterReload = r.did === did ? true : `failed: ${r.error ?? r.did}`;
        check("PRF passkey: unlock with the passkey restores the same identity", r.did === did, r.error ?? "");
      }
    } else if (outcome === "create-password") {
      // PRF requested but not returned inside WebView2: a real limitation, not a test failure.
      check("PRF passkey: WebView2 returned a PRF result", false, `fell back to the password form: ${await alertText(page)}`, false);
    } else {
      // WebAuthn threw: the app must still let the user in (password), or this is a product bug.
      check("PRF passkey: navigator.credentials.create works in WebView2", false, outcome, false);
    }
    annotate(
      "notice",
      "webview2-prf",
      `virtual authenticator hasPrf=true -> create=${outcome} storedMethod=${facts.prf.storedMethod} ` +
        `unlockAfterReload=${facts.prf.unlockAfterReload ?? "n/a"}`,
    );
  } else {
    annotate("warning", "webview2-prf", "WebAuthn API is missing in WebView2; passkey path skipped");
  }

  // ---- restart: identity persists in IndexedDB; passkey unlock after restart
  let exportedCreds = [];
  if (prfAuth && facts.prf.did) {
    exportedCreds = (await cdp.send("WebAuthn.getCredentials", { authenticatorId: prfAuth })).credentials;
    const how = await closeApp();
    app = await launchApp();
    ({ page, cdp } = app);
    const st = await waitState(page, ["unlock-passkey", "unlock-password", "create", "main"]);
    const rec = await storedRecord(page);
    facts.prf.restart = { close: how, screen: st, storedDid: rec?.did === facts.prf.did };
    check("restart (PRF identity): identity persisted in IndexedDB", rec?.did === facts.prf.did, `close=${how}`);
    check("restart (PRF identity): passkey unlock screen shown", st === "unlock-passkey", st);
    // The virtual authenticator lives only as long as the CDP session; put the same credential back.
    const auth = await addAuthenticator(cdp, true);
    for (const c of exportedCreds) await cdp.send("WebAuthn.addCredential", { authenticatorId: auth, credential: c });
    if (st === "unlock-passkey") {
      const r = await unlockWithPasskey(page);
      facts.prf.restart.unlock = r.did === facts.prf.did ? "ok" : `failed: ${r.error ?? r.did}`;
      // A re-imported virtual credential may not carry the same PRF secret: informational only.
      check("restart (PRF identity): passkey unlock after restart", r.did === facts.prf.did, facts.prf.restart.unlock, false);
    }
    annotate(
      "notice",
      "webview2-restart-prf",
      `close=${how} screen=${st} identityPersisted=${facts.prf.restart.storedDid} unlock=${facts.prf.restart.unlock ?? "n/a"}`,
    );
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: auth }).catch(() => undefined);
  } else if (prfAuth) {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: prfAuth }).catch(() => undefined);
  }

  // ---- scenario 2: passkey without PRF -> device password
  await wipeIdentity(page);
  await waitState(page, "create");
  facts.password = {};
  if (webauthnOk) await addAuthenticator(cdp, false);
  const outcome = await clickCreate(page);
  facts.password.createOutcome = outcome;
  check("no PRF: the app asks for a device password", outcome === "create-password", outcome);
  if (outcome === "create-password") {
    facts.password.prompt = await alertText(page);
    const fields = page.locator('input[autocomplete="new-password"]');
    await fields.nth(0).fill(PASSWORD);
    await fields.nth(1).fill(PASSWORD);
    await page.locator("main > form.screen button[type=submit]").click();
    await waitState(page, "mnemonic", 60_000);
    const rec = await storedRecord(page);
    facts.password.storedMethod = rec?.unlockMethod;
    const { words, did } = await confirmMnemonic(page);
    facts.password.did = did;
    check("no PRF: identity created with the password", rec?.unlockMethod === "password", `method=${rec?.unlockMethod}`);
    check("no PRF: 12 recovery words shown, did:key on the main screen", words === 12 && did.startsWith("did:key:z6Mk"));
    await page.reload();
    const locked = await waitState(page, ["unlock-password", "unlock-passkey", "create"]);
    check("no PRF: reload shows the password unlock screen", locked === "unlock-password", locked);
    await unlockWithPassword(page, "wrong password 123");
    await page.waitForFunction(() => document.querySelector('main [role="alert"]'), null, { timeout: 30_000 });
    check("no PRF: a wrong password is rejected", (await screenState(page)) === "unlock-password", await alertText(page));
    await unlockWithPassword(page, PASSWORD);
    const did2 = await mainDid(page);
    facts.password.unlockAfterReload = did2 === did;
    check("no PRF: the right password unlocks the same identity", did2 === did);
  }
  annotate(
    "notice",
    "webview2-password",
    `virtual authenticator hasPrf=false -> create=${outcome} storedMethod=${facts.password.storedMethod} ` +
      `unlockAfterReload=${facts.password.unlockAfterReload ?? "n/a"} prompt="${facts.password.prompt ?? ""}"`,
  );

  // ---- restart: password identity persists and unlocks
  if (facts.password.did) {
    const how = await closeApp();
    app = await launchApp();
    ({ page, cdp } = app);
    const st = await waitState(page, ["unlock-password", "unlock-passkey", "create", "main"]);
    const rec = await storedRecord(page);
    check("restart (password identity): identity persisted in IndexedDB", rec?.did === facts.password.did, `close=${how}`);
    check("restart (password identity): password unlock screen shown", st === "unlock-password", st);
    let unlocked = false;
    if (st === "unlock-password") {
      await unlockWithPassword(page, PASSWORD);
      unlocked = (await mainDid(page)) === facts.password.did;
      check("restart (password identity): unlock after restart", unlocked);
    }
    facts.password.restart = { close: how, screen: st, persisted: rec?.did === facts.password.did, unlocked };
    annotate(
      "notice",
      "webview2-restart-password",
      `close=${how} screen=${st} identityPersisted=${facts.password.restart.persisted} unlock=${unlocked}`,
    );
  }
  facts.screenshot = await screenshot(cdp, page, "webview2-final");

  // ---- scenario 3: the passkey prompt is cancelled (or no Windows Hello answers).
  // The app must offer a password instead of leaving the user on the intro screen.
  if (webauthnOk) {
    await wipeIdentity(page);
    await waitState(page, "create");
    const refusing = await addAuthenticator(cdp, true, false);
    const t0 = Date.now();
    const outcome = await clickCreate(page);
    facts.cancelled = { createOutcome: outcome, seconds: Math.round((Date.now() - t0) / 1000) };
    // The intro screen also has "I have another device" (transfer), so there can be two secondary
    // buttons; the password fallback is the one after it.
    const fallback = page.locator("main > .screen > button.secondary").last();
    const offered = outcome.startsWith("error") && (await page.locator("main > .screen > button.secondary").count()) >= 1;
    check("passkey cancelled: the app offers a password", offered, outcome);
    if (offered) {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: refusing });
      await fallback.click();
      await waitState(page, "create-password");
      const fields = page.locator('input[autocomplete="new-password"]');
      await fields.nth(0).fill(PASSWORD);
      await fields.nth(1).fill(PASSWORD);
      await page.locator("main > form.screen button[type=submit]").click();
      await waitState(page, "mnemonic", 60_000);
      const rec = await storedRecord(page);
      const { did } = await confirmMnemonic(page);
      facts.cancelled.storedMethod = rec?.unlockMethod;
      check(
        "passkey cancelled: identity created with the password",
        rec?.unlockMethod === "password" && did.startsWith("did:key:z6Mk"),
        `method=${rec?.unlockMethod}`,
      );
    }
    annotate(
      "notice",
      "webview2-cancelled",
      `refusing authenticator -> ${outcome} after ${facts.cancelled.seconds}s, password offered=${offered}, ` +
        `storedMethod=${facts.cancelled.storedMethod ?? "n/a"}`,
    );
  }

  // ---- scenario 4: Windows Hello unlock (Tauri command). A CI runner has no Windows Hello,
  // so this checks what it can: the command answers, the capability lets only the two Hello
  // commands through, foreign credential names are refused before any prompt, and with Hello
  // unavailable the unlock screen stays a plain password screen (no Hello button/checkbox).
  facts.hello = await page.evaluate(async () => {
    const t = window.__TAURI_INTERNALS__;
    if (!t?.invoke) return { tauri: false };
    const tryInvoke = async (cmd, args) => {
      try {
        return { ok: true, value: await t.invoke(cmd, args) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    };
    return {
      tauri: true,
      status: await tryInvoke("windows_hello_status"),
      foreignName: await tryInvoke("windows_hello_sign", { name: "other-app-0123456789abcdef", challenge: Array(32).fill(0), create: false }),
      shortChallenge: await tryInvoke("windows_hello_sign", { name: "p2p-messenger-0123456789abcdef", challenge: [1, 2, 3], create: false }),
      notAllowed: await tryInvoke("plugin:app|version"),
    };
  });
  const h = facts.hello;
  if (!h.tauri) {
    annotate("notice", "windows-hello", "INFO: not running in the Tauri shell (local Chromium run); Hello checks skipped");
  } else {
    const helloStatus = h.status.ok ? h.status.value : `error: ${h.status.error}`;
    check("windows_hello_status answers", h.status.ok && ["available", "unavailable"].includes(h.status.value), helloStatus);
    check("windows_hello_sign refuses foreign credential names", !h.foreignName.ok, h.foreignName.error ?? "accepted");
    check("windows_hello_sign refuses non-32-byte challenges", !h.shortChallenge.ok, h.shortChallenge.error ?? "accepted");
    check("capability blocks other Tauri commands", !h.notAllowed.ok, h.notAllowed.error ?? "allowed");
    if (helloStatus !== "available") {
      annotate("notice", "windows-hello", `INFO: Windows Hello is not available here (${helloStatus}); checking that the method stays hidden`);
      const rec = await storedRecord(page);
      if (rec) {
        await page.reload();
        const st = await waitState(page, ["unlock-password", "unlock-passkey", "main"], 30_000);
        if (st === "unlock-password") {
          const helloUi = await page.evaluate(
            () => document.querySelectorAll('main input[type="checkbox"]').length +
              [...document.querySelectorAll("main button")].filter((b) => /Windows Hello/.test(b.textContent ?? "")).length,
          );
          check("Hello unavailable: unlock screen has no Hello button or checkbox", helloUi === 0, `${helloUi} Hello control(s)`);
          await unlockWithPassword(page, PASSWORD);
          check("Hello unavailable: password unlock still works", (await waitState(page, ["main"], 60_000)) === "main");
        }
      }
    } else {
      annotate("notice", "windows-hello", "INFO: Windows Hello reports available; enrolment needs a real user and is not automated");
    }
  }
  await closeApp();
} catch (err) {
  fatalError = err;
  log(`ERROR ${err.stack ?? err}`);
  if (current) {
    try {
      facts.screenshot = await screenshot(current.cdp, current.page, "webview2-final");
    } catch {
      // no screenshot
    }
    await closeApp().catch(() => undefined);
  }
} finally {
  staticServer?.close();
  if (policySet) await run("reg", ["delete", POLICY_KEY, "/f"]);
}

if (fatalError?.noDevtools && !debugVia && !DEVTOOLS_VIA) {
  // Not an app failure: the next workflow step rebuilds the app with the port in its config.
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, "devtools=unavailable\n", { flag: "a" });
  annotate("warning", "webview2-devtools", `${fatalError.message}; the identity test runs on a build with additionalBrowserArgs instead`);
  process.exit(0);
}

facts.devtools = debugVia ?? "local";
facts.pageErrors = allPageErrors;
facts.consoleErrors = allConsoleErrors;
facts.checks = checks;
writeFileSync(join(OUT_DIR, "webview2-identity.json"), JSON.stringify(facts, null, 2));

check("no uncaught page errors", allPageErrors.length === 0, allPageErrors.slice(0, 3).join(" | "));
if (allConsoleErrors.length) {
  annotate("warning", "webview2-console", `${allConsoleErrors.length} console error(s): ${allConsoleErrors.slice(0, 3).join(" | ")}`);
}
const failed = checks.filter((c) => !c.ok && c.fatal);
const limits = checks.filter((c) => !c.ok && !c.fatal);
for (const c of failed.slice(0, 8)) annotate("error", "webview2-check", `${c.name}${c.detail ? ": " + c.detail : ""}`);
for (const c of limits.slice(0, 4)) annotate("warning", "webview2-limitation", `${c.name}: ${c.detail}`);
if (fatalError) annotate("error", "webview2-error", String(fatalError.message ?? fatalError));
const passed = checks.filter((c) => c.ok).length;
annotate(
  "notice",
  "webview2-result",
  `${failed.length || fatalError ? "FAIL" : "PASS"}: ${passed}/${checks.length} checks passed, ${limits.length} known limitation(s), ` +
    `${allPageErrors.length} page error(s)`,
);
process.exit(failed.length || fatalError ? 1 : 0);
