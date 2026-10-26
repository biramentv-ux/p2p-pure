/**
 * Desktop identity test: drives the INSTALLED Windows app (Tauri 2 + WebView2) through
 * the Chrome DevTools Protocol. There is no Windows Hello on a CI runner, so a CDP
 * virtual authenticator stands in for it:
 *
 *   1. passkey with PRF  -> create identity, lock (reload), unlock with the passkey,
 *                           restart the app, identity still there, unlock again;
 *   2. passkey without PRF -> the app must fall back to a device password: create,
 *                           wrong password rejected, unlock, restart, unlock again.
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

async function launchApp() {
  if (await cdpUp()) throw new Error(`port ${PORT} is already in use before launch`);
  let child;
  if (APP_EXE) {
    child = spawn(APP_EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: "ignore",
    });
  } else {
    staticServer ??= await startStaticServer(resolve(LOCAL_DIST));
    localProfile ??= mkdtempSync(join(tmpdir(), "webview2-identity-"));
    const url = `http://tauri.localhost:${staticServer.address().port}/`;
    child = spawn(CHROME_PATH, [
      "--headless=new", "--no-sandbox", "--no-first-run", `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${localProfile}`, "--window-size=480,860", url,
    ], { stdio: "ignore" });
  }
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  const version = await Promise.race([
    waitFor(cdpUp, 60_000, "the WebView2 DevTools endpoint"),
    exited.then((code) => { throw new Error(`app exited during start (code ${code})`); }),
  ]);
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

async function addAuthenticator(cdp, hasPrf) {
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf,
    },
  });
  return authenticatorId;
}

/** Create button -> mnemonic (passkey) or password form (no PRF), or an error on the intro screen. */
async function clickCreate(page) {
  await page.locator("main > .screen > button").click();
  return waitState(page, ["mnemonic", "create-password", "create"], 45_000).then(async (s) => {
    if (s !== "create") return s;
    // Still on the intro: either busy or an error was shown.
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      const st = await screenState(page);
      if (st !== "create") return st;
      const alert = await alertText(page);
      const busy = await page.locator("main > .screen > button").isDisabled();
      if (alert && !busy) return `error: ${alert}`;
      await page.waitForTimeout(300);
    }
    return "create (no reaction)";
  });
}

async function confirmMnemonic(page) {
  const words = await page.locator("ol.mnemonic-grid li").count();
  await page.locator('main > .screen input[type="checkbox"]').check();
  await page.locator("main > .screen > button").click();
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
  await page.locator("main > .screen > button").click();
  return waitFor(async () => {
    const st = await screenState(page).catch(() => "evaluating");
    if (st === "main") return { did: (await page.locator(".did-text").innerText()).trim() };
    if (st !== "unlock-passkey") return null;
    const alert = await alertText(page);
    const busy = await page.locator("main > .screen > button").isDisabled().catch(() => true);
    return alert && !busy ? { error: alert } : null;
  }, 45_000, "passkey unlock to finish");
}

async function mainDid(page) {
  await waitState(page, "main", 45_000);
  return (await page.locator(".did-text").innerText()).trim();
}

/** JPEG of the window, small enough for the annotation chunks (<= ~27 000 base64 chars). */
async function screenshot(cdp, page, name) {
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
    `origin=${e.origin} secureContext=${e.isSecureContext} navigator.credentials=${e.navigatorCredentials} ` +
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
}

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
