/**
 * Call end-to-end: two real app pages (Chromium, fake camera and microphone). They
 * connect through the paste flow, then run a video call and an audio call, check that
 * media arrives, mute and hang-up. Real WebRTC, no mocks in the media path.
 *
 *   npm run test:call
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
setTimeout(() => {
  console.error("WATCHDOG: aborting after 560s");
  process.exit(2);
}, 560_000).unref();

const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    // getDisplayMedia picks the screen without a dialog (screen sharing check).
    "--auto-select-desktop-capture-source=Entire screen",
    "--auto-accept-this-tab-capture",
  ],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function openApp() {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const page = await ctx.newPage();
  // Diagnostics only: remember the peer connections so a failing run can show their state.
  await page.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Orig {
      constructor(...args) {
        super(...args);
        window.__pcs.push(this);
        this.addEventListener("track", (e) => (window.__tracks = [...(window.__tracks ?? []), e.track.kind]));
      }
    };
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");
  return { page, errors, ctx };
}

async function createIdentity(page) {
  await page.getByRole("button", { name: "Създай идентичност" }).click();
  const pwd = page.locator('input[type="password"]').first();
  const grid = page.locator("ol.mnemonic-grid");
  await Promise.race([pwd.waitFor({ timeout: 30_000 }), grid.waitFor({ timeout: 30_000 })]);
  if (await pwd.isVisible()) {
    await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
    await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
    await page.locator("form button[type=submit]").click();
    await grid.waitFor({ timeout: 30_000 });
  }
  await page.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Продължи" }).click();
}

async function readQr(page) {
  const end = Date.now() + 30_000;
  for (;;) {
    await page.locator("canvas[aria-label]").first().waitFor({ timeout: 30_000 });
    const text = await page.evaluate(async () => {
      const c = document.querySelector("canvas[aria-label]");
      if (!c || c.width === 0) return null;
      const img = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      const mod = await import("/src/p2p/qrDecode.ts");
      return mod.decodeQrFromPixels(img.data, img.width, img.height);
    });
    if (text) return text;
    if (Date.now() > end) throw new Error("QR could not be decoded");
    await page.waitForTimeout(300);
  }
}

async function pasteCode(page, payload) {
  await page.locator("details summary").click();
  await page.locator('textarea[aria-label="Поканен код"]').fill(payload);
  await page.getByRole("button", { name: "Използвай кода" }).click();
}

/** Diagnostic snapshot of the page's peer connection. */
async function pcState(page) {
  return page.evaluate(() => {
    const pc = window.__pcs?.at(-1);
    if (!pc) return "no pc";
    return {
      panel: document.querySelector(".call-panel")?.innerText.replace(/\n+/g, " / ") ?? "no panel",
      signaling: pc.signalingState,
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      tracks: window.__tracks ?? [],
      senders: pc.getSenders().map((s) => s.track?.kind ?? "null"),
      receivers: pc.getReceivers().map((r) => `${r.track.kind}:${r.track.readyState}:${r.track.muted ? "muted" : "live"}`),
      transceivers: pc.getTransceivers().map((t) => `${t.mid}/${t.direction}/${t.currentDirection}/${t.sender.track?.kind ?? "-"}/${t.receiver.track.kind}`),
      localDirs: (pc.localDescription?.sdp.match(/^a=(sendrecv|sendonly|recvonly|inactive)\r?$/gm) ?? []).join(","),
      remoteDirs: (pc.remoteDescription?.sdp.match(/^a=(sendrecv|sendonly|recvonly|inactive)\r?$/gm) ?? []).join(","),
    };
  });
}

/** Media is flowing when the remote element has decoded frames or audio samples. */
async function remoteMediaFlowing(page, kind) {
  return page.waitForFunction(
    (k) => {
      const el =
        k === "video"
          ? document.querySelector('video[aria-label="Видео на събеседника"]')
          : document.querySelector("audio");
      if (!el || !el.srcObject) return false;
      if (k === "video") return el.videoWidth > 0 && el.readyState >= 2;
      return el.srcObject.getAudioTracks().length > 0 && !el.paused;
    },
    kind,
    { timeout: 45_000 },
  ).then(() => true, () => false);
}

/**
 * Connects two fresh pages through the paste flow. Headless ICE sometimes stalls on
 * this sandbox (the same happens in ui.mjs), so a stalled attempt is retried with new pages.
 */
async function connectPair(attempts = 3) {
  for (let n = 1; n <= attempts; n++) {
    const alice = await openApp();
    const bob = await openApp();
    try {
      await createIdentity(alice.page);
      await createIdentity(bob.page);
      await alice.page.getByRole("button", { name: "Свържи се" }).click();
      await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
      const offer = await readQr(alice.page);
      await bob.page.getByRole("button", { name: "Свържи се" }).click();
      await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
      await pasteCode(bob.page, offer);
      const answer = await readQr(bob.page);
      await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
      await pasteCode(alice.page, answer);
      await alice.page.locator(".safety-code").waitFor({ timeout: 45_000 });
      await alice.page.getByPlaceholder("Например: Иван").fill("Боб");
      await bob.page.getByPlaceholder("Например: Иван").fill("Алиса");
      await alice.page.getByRole("button", { name: "Думите съвпадат" }).click();
      await bob.page.getByRole("button", { name: "Думите съвпадат" }).click();
      await alice.page.locator(".chat").waitFor({ timeout: 30_000 });
      await bob.page.locator(".chat").waitFor({ timeout: 30_000 });
      console.log(`  connected on attempt ${n}`);
      return { alice, bob };
    } catch (err) {
      console.log(`  attempt ${n} stalled: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      await alice.ctx.close();
      await bob.ctx.close();
    }
  }
  throw new Error(`connection did not establish in ${attempts} attempts`);
}

try {
  const { alice, bob } = await connectPair();
  check("chat connected", true);

  // ---- Video call: Alice calls, Bob accepts ----
  await alice.page.getByRole("button", { name: "Видео разговор" }).click();
  await bob.page.getByRole("region", { name: "Входящ разговор" }).waitFor({ timeout: 15_000 });
  check("incoming video call is shown to Bob", true);
  await bob.page.getByRole("button", { name: "Приеми" }).click();

  await alice.page.getByRole("region", { name: "Разговор" }).waitFor({ timeout: 30_000 });
  await bob.page.getByRole("region", { name: "Разговор" }).waitFor({ timeout: 30_000 });
  check("both sides are in the video call", true);
  // The phase must reach "active": the call shares the chat's connection, which is already up.
  for (const pg of [alice.page, bob.page]) {
    await pg.getByRole("region", { name: "Разговор" }).getByRole("status").filter({ hasText: "В разговор" }).waitFor({ timeout: 30_000 });
  }
  check("both sides show \"В разговор\" (active phase)", true);

  const videoA = await remoteMediaFlowing(alice.page, "video");
  if (!videoA) console.log("  diag alice:", JSON.stringify(await pcState(alice.page)));
  if (!videoA) console.log("  diag bob:", JSON.stringify(await pcState(bob.page)));
  check("Alice receives Bob's video", videoA);
  check("Bob receives Alice's video", await remoteMediaFlowing(bob.page, "video"));

  // Н6: the link quality shows during the call (getStats every 2 s).
  await alice.page.locator(".call-quality").waitFor({ timeout: 15_000 });
  const qual = await alice.page.locator(".call-quality").innerText();
  check("the call shows the link quality", /връзка/.test(qual), qual);

  // Н6: share the screen instead of the camera, then stop; the call stays up.
  const share = alice.page.getByRole("button", { name: "Сподели екрана" });
  if (await share.count()) {
    await share.click();
    await alice.page.getByText("Споделяш екрана си.").waitFor({ timeout: 15_000 });
    check("screen sharing replaces the camera", true);
    await alice.page.getByRole("button", { name: "Спри споделянето" }).click();
    await alice.page.getByText("Споделяш екрана си.").waitFor({ state: "detached", timeout: 15_000 });
    check("stopping the share goes back to the camera, call still active", (await alice.page.getByText("В разговор").count()) > 0);
  } else {
    check("screen sharing button present on desktop Chromium", false);
  }

  // Mute on Alice's side: her local microphone track is disabled.
  await alice.page.getByRole("button", { name: "Заглуши" }).click();
  const muted = await alice.page.evaluate(() => {
    const local = document.querySelector('video[aria-label="Твоето видео"]');
    return local?.srcObject?.getAudioTracks().every((t) => t.enabled === false) ?? false;
  });
  check("mute disables the local microphone track", muted);
  await alice.page.getByRole("button", { name: "Включи микрофона" }).click();

  // Hang up from Alice: Bob's call ends too.
  await alice.page.getByRole("button", { name: "Край" }).click();
  await bob.page.getByText("Другият човек затвори разговора.").waitFor({ timeout: 15_000 });
  check("hang-up ends the call on the other side", true);

  // ---- Audio call: Bob calls, Alice accepts ----
  await bob.page.getByRole("button", { name: "Аудио разговор" }).click();
  await alice.page.getByRole("region", { name: "Входящ разговор" }).waitFor({ timeout: 15_000 });
  await alice.page.getByRole("button", { name: "Приеми" }).click();
  await bob.page.getByRole("region", { name: "Разговор" }).waitFor({ timeout: 30_000 });
  check("Alice receives Bob's audio", await remoteMediaFlowing(alice.page, "audio"));
  check("Bob receives Alice's audio", await remoteMediaFlowing(bob.page, "audio"));
  await bob.page.getByRole("button", { name: "Край" }).click();
  await alice.page.getByText("Другият човек затвори разговора.").waitFor({ timeout: 15_000 });

  // ---- Declined call ----
  await alice.page.getByRole("button", { name: "Аудио разговор" }).click();
  await bob.page.getByRole("region", { name: "Входящ разговор" }).waitFor({ timeout: 15_000 });
  await bob.page.getByRole("button", { name: "Откажи" }).click();
  await alice.page.getByText("Другият човек отказа.").waitFor({ timeout: 15_000 });
  check("decline is shown to the caller", true);

  // ---- Chat still works after calls ----
  await alice.page.locator(".composer input").fill("след разговорите");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "след разговорите" }).waitFor({ timeout: 30_000 });
  check("text chat still works after calls", true);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("call run completed without exception", false, err instanceof Error ? err.message.split("\n").slice(0, 3).join(" / ") : String(err));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
