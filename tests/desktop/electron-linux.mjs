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
 * Opt-in extras (command line of the test only, nothing of this is built into the app):
 *   WAYLAND=1        starts a headless Weston and runs the app on it with --ozone-platform=wayland
 *                    (no X11 display is given to the app); the same checks must pass, and the app
 *                    process must really have loaded libwayland-client.
 *   FAKE_CAMERA=auto|<file.y4m>
 *                    a last run with Chromium's fake camera (--use-fake-device-for-media-stream
 *                    --use-file-for-fake-video-capture) and the app's own permission handler (the
 *                    fake-UI flag is NOT used): getUserMedia must work, and the QR scanner screen must
 *                    decode the QR code in the video. "auto" builds the video with ffmpeg from the
 *                    invitation QR the app itself shows; a file must contain a current invitation.
 *                    A fake camera tests the software path (permission, getUserMedia, decoder), not
 *                    real camera hardware.
 */
import { chromium } from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

const WAYLAND = process.env.WAYLAND === "1";
const FAKE_CAMERA = process.env.FAKE_CAMERA ?? "";
let appEnv = process.env;
let weston = null;
if (WAYLAND) {
  // A real compositor, headless: no X server is reachable for the app, so it cannot fall back to X11.
  const runtime = mkdtempSync(join(tmpdir(), "p2p-xdg-"));
  chmodSync(runtime, 0o700);
  const socket = "p2p-wl-test";
  weston = spawn("weston", ["--backend=headless", "--socket=" + socket, "--width=1280", "--height=900"], {
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, XDG_RUNTIME_DIR: runtime },
  });
  for (let i = 0; i < 50 && !existsSync(join(runtime, socket)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!existsSync(join(runtime, socket))) {
    console.error("weston did not create its socket");
    process.exit(2);
  }
  appEnv = { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: socket, XDG_SESSION_TYPE: "wayland" };
  delete appEnv.DISPLAY;
  log(`weston up on ${socket}`);
}
process.on("exit", () => weston?.kill());

const PORT = 9333;
/**
 * Starts the app and attaches over the Chromium DevTools port. The shipped app has the Node.js
 * inspector fuse switched off, so Playwright's own Electron launcher (which needs it) is not
 * used: the test must run against the very binary users get.
 */
async function launch(extraArgs = []) {
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, ...extraArgs];
  if (process.env.NO_SANDBOX) args.push("--no-sandbox");
  if (WAYLAND) args.push("--ozone-platform=wayland");
  const child = spawn(APP_BIN ?? dev, APP_BIN ? args : [...args, resolve("electron/main.mjs")], { stdio: "ignore", detached: true, env: appEnv });
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
    pid: child.pid,
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

// The app follows the system language; the checks below name buttons in Bulgarian.
const bulgarian = (page) => page.getByRole("button", { name: /^БГ/ }).click({ timeout: 3000 }).catch(() => {});

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
  if (WAYLAND) {
    const maps = readFileSync(`/proc/${app.pid}/maps`, "utf8");
    const env = readFileSync(`/proc/${app.pid}/environ`, "utf8").split("\0");
    check(
      "app runs on Wayland (libwayland-client loaded, no DISPLAY, WAYLAND_DISPLAY set)",
      maps.includes("libwayland-client") && !env.some((e) => e.startsWith("DISPLAY=")) && env.some((e) => e.startsWith("WAYLAND_DISPLAY=")),
    );
  }

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
  // The copy buttons of the app write to the clipboard; reading it must stay refused.
  const clip = await page.evaluate(async () => {
    window.focus();
    const wrote = await navigator.clipboard.writeText("p2p").then(() => true, () => false);
    const read = await navigator.clipboard.readText().then(() => true, () => false);
    return { wrote, read };
  });
  check("copy to the clipboard works, reading it is refused", clip.wrote && !clip.read, JSON.stringify(clip));
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
  let cameraFile = FAKE_CAMERA === "auto" ? "" : FAKE_CAMERA;
  if (FAKE_CAMERA === "auto") {
    // The invitation QR the app shows is the picture the fake camera will film.
    await bulgarian(page);
    await page.getByRole("button", { name: "Свържи се" }).click();
    await page.getByRole("button", { name: "Покажи моята покана" }).click();
    await page.waitForSelector("canvas[aria-label]", { timeout: 30_000 });
    let shot = null;
    for (let i = 0; i < 50 && !shot; i++) {
      shot = await page.evaluate(() => {
        const c = document.querySelector("canvas[aria-label]");
        return c && c.width > 0 ? { url: c.toDataURL("image/png"), size: c.width } : null;
      });
      if (!shot) await page.waitForTimeout(300);
    }
    if (!shot) throw new Error("the invitation QR was not drawn");
    const png = join(OUT, "invite-qr.png");
    cameraFile = join(OUT, "invite-qr.y4m");
    writeFileSync(png, Buffer.from(shot.url.split(",")[1], "base64"));
    const k = Math.max(1, Math.floor(400 / shot.size));
    const ff = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-loop", "1", "-i", png, "-vf", `scale=iw*${k}:ih*${k}:flags=neighbor,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p`, "-frames:v", "30", "-r", "10", cameraFile],
      { encoding: "utf8" },
    );
    check("ffmpeg made a y4m video of the invitation QR", ff.status === 0 && existsSync(cameraFile), ff.stderr?.slice(0, 200));
  }
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

  if (cameraFile) {
    await app.close();
    // Only the test command line carries the fake-device flags. No --use-fake-ui-for-media-stream:
    // the request goes through the app's own permission handler.
    ({ app, page } = await launch(["--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${cameraFile}`]));
    await waitState(page, ["unlock-password", "main"]);
    if ((await state(page)) === "unlock-password") {
      await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
      await page.locator("main > form.screen button[type=submit]").click();
      await waitState(page, ["main"]);
    }
    const cam = await page.evaluate(async () => {
      try {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput").length;
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        const track = stream.getVideoTracks()[0];
        const v = document.createElement("video");
        v.muted = true;
        v.srcObject = stream;
        await v.play();
        await new Promise((r) => setTimeout(r, 500));
        const out = { ok: true, devices, state: track.readyState, w: v.videoWidth, h: v.videoHeight };
        stream.getTracks().forEach((t) => t.stop());
        return out;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    log(`camera ${JSON.stringify(cam)}`);
    check("getUserMedia works through the app's permission handler", cam.ok && cam.state === "live" && cam.w > 0, JSON.stringify(cam));

    await bulgarian(page);
    await page.getByRole("button", { name: "Свържи се" }).click();
    await page.getByRole("button", { name: "Сканирай чужда покана" }).click();
    // Nothing is pasted: the scanner has to read the QR code from the camera video by itself.
    // Decoding the invitation moves the app on to its answer QR code.
    const decoded = await page.waitForSelector("canvas[aria-label]", { timeout: 40_000 }).then(() => true, () => false);
    const alert = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
    await page.screenshot({ path: join(OUT, "electron-scanner.png") });
    check("QR scanner decodes the invitation from the fake camera", decoded && alert.length === 0, alert.join(" | "));
  }
} catch (err) {
  failures++;
  console.error("FAILED", err);
  await page?.screenshot({ path: join(OUT, "electron-failed.png") }).catch(() => {});
} finally {
  await app?.close().catch(() => {});
  weston?.kill();
}
log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
