/**
 * Files end to end, two real pages over a real WebRTC link: a GIF shown inline, a 100 MB file
 * byte for byte (SHA-256 compared), a file over the limit refused before anything is sent,
 * and a declined file. No server sees any of it.
 *
 *   npm run test:files
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function openApp() {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  await page.goto(base + "/");
  return { ctx, page, errors };
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

/** Connects two fresh pages; a stalled headless ICE attempt is retried with new pages. */
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

const dir = mkdtempSync(join(tmpdir(), "p2p-files-"));
const MB = 1024 * 1024;

/** Picks a file through the "Файл" button (the hidden input next to it). */
async function pick(page, path) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Прикачи файл или видео до 100 MB" }).click();
  await (await chooser).setFiles(path);
}

/** Puts a file straight into the input the "Файл" button opens (no chooser dialog). */
async function put(page, path) {
  await page.locator("input[type=file]:not([accept])").setInputFiles(path);
}

/** SHA-256 (hex) of the file behind a download link in the page. */
async function hashOfLink(page, name) {
  return page.evaluate(async (n) => {
    const a = [...document.querySelectorAll("a.file-download")].find((x) => x.getAttribute("download") === n);
    if (!a) return null;
    const buf = await (await fetch(a.href)).arrayBuffer();
    const d = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, name);
}

let pages = null;
try {
  const { alice, bob } = await connectPair();
  pages = { alice, bob };
  check("chat connected", true);

  // ---- A small GIF: offered, accepted, shown inline on both sides ----
  const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  const gifPath = join(dir, "smile.gif");
  writeFileSync(gifPath, gif);
  await pick(alice.page, gifPath);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 30_000 });
  check("Bob sees an offer before anything is downloaded", (await bob.page.locator(".messages img.msg-image").count()) === 0);
  await bob.page.locator(".transfer").getByRole("button", { name: "Приеми" }).click();
  await bob.page.locator('.messages .msg.in img[alt="smile.gif"]').waitFor({ timeout: 30_000 });
  await alice.page.locator('.messages .msg.out img[alt="smile.gif"]').waitFor({ timeout: 30_000 });
  check("a GIF arrives and shows inline on both sides", true);

  // ---- 100 MB exactly: byte for byte ----
  // Playwright's file chooser does not pass files over 50 MB, so the 100 MB file is made in the
  // page itself (random bytes) and put into the same input the "Файл" button opens.
  const started = Date.now();
  const bigHash = await alice.page.evaluate(async (size) => {
    const parts = [];
    for (let off = 0; off < size; off += 65536) parts.push(crypto.getRandomValues(new Uint8Array(Math.min(65536, size - off))));
    const file = new File(parts, "архив-100MB.bin", { type: "application/octet-stream" });
    const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const input = [...document.querySelectorAll("input[type=file]")].find((x) => !x.accept);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, 100 * MB);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 60_000 });
  await bob.page.locator(".transfer").getByRole("button", { name: "Приеми" }).click();
  await bob.page.locator(".transfer progress").first().waitFor({ timeout: 30_000 });
  check("progress is shown while the file moves", true);
  await bob.page.locator('a.file-download[download="архив-100MB.bin"]').waitFor({ timeout: 300_000 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const gotHash = await hashOfLink(bob.page, "архив-100MB.bin");
  check("100 MB arrives byte for byte (SHA-256 equal)", gotHash === bigHash, `${secs} s`);
  await alice.page.locator('a.file-download[download="архив-100MB.bin"]').waitFor({ timeout: 30_000 });
  check("the sender sees the sent file in the chat", true);

  // ---- Resume (Н5): the link drops half-way; the next link finishes the same file ----
  const resumeHash = await alice.page.evaluate(async (size) => {
    const parts = [];
    for (let off = 0; off < size; off += 65536) parts.push(crypto.getRandomValues(new Uint8Array(Math.min(65536, size - off))));
    const file = new File(parts, "resume-60MB.bin", { type: "application/octet-stream" });
    const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const input = [...document.querySelectorAll("input[type=file]")].find((x) => !x.accept);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, 60 * MB);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 60_000 });
  await bob.page.locator(".transfer").getByRole("button", { name: "Приеми" }).click();
  // Cut the link once a few chunks are through, well before the end.
  await bob.page.waitForFunction(() => Number(document.querySelector(".transfer progress")?.value ?? 0) >= 5, null, { timeout: 120_000 });
  await bob.page.getByRole("button", { name: "Назад" }).click();
  await alice.page.getByText("прекъснато на").waitFor({ timeout: 30_000 });
  check("a dropped link shows the file as paused on the sender", true);
  await alice.page.getByRole("button", { name: "Назад" }).click();
  // Reconnect the same two contacts (verified: no safety step).
  await alice.page.getByRole("button", { name: "Контакти" }).click();
  await alice.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await alice.page.getByRole("button", { name: "Покажи моята покана" }).click();
  const offerR = await readQr(alice.page);
  await bob.page.getByRole("button", { name: "Контакти" }).click();
  await bob.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  await bob.page.getByRole("button", { name: "Сканирай чужда покана" }).click();
  await pasteCode(bob.page, offerR);
  const answerR = await readQr(bob.page);
  await alice.page.getByRole("button", { name: "Сканирай отговора" }).click();
  await pasteCode(alice.page, answerR);
  await alice.page.locator(".chat").waitFor({ timeout: 60_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 60_000 });
  await bob.page.locator('a.file-download[download="resume-60MB.bin"]').waitFor({ timeout: 300_000 });
  check("the file continues on the next link and arrives byte for byte", (await hashOfLink(bob.page, "resume-60MB.bin")) === resumeHash);
  await alice.page.locator('a.file-download[download="resume-60MB.bin"]').waitFor({ timeout: 30_000 });
  check("the sender's chat gets the finished file", true);

  // ---- Over the limit: refused before any offer ----
  const offersBefore = await bob.page.getByText("иска да ти изпрати файл").count();
  await alice.page.evaluate((size) => {
    const file = new File([new Uint8Array(size)], "too-big.bin");
    const input = [...document.querySelectorAll("input[type=file]")].find((x) => !x.accept);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, 100 * MB + 1);
  const alert = await alice.page.locator('[role="alert"]').first().innerText({ timeout: 15_000 }).catch(() => "");
  await bob.page.waitForTimeout(1500);
  check("a file over 100 MB is refused with a message", /100 MB/.test(alert), alert);
  check("nothing is offered for it", (await bob.page.getByText("иска да ти изпрати файл").count()) === offersBefore);

  // ---- Declined ----
  // Latin file name: Playwright does not pass Cyrillic paths in headless Chromium. Cyrillic
  // names are covered by the 100 MB file made in the page and by the unit tests.
  const smallPath = join(dir, "note.txt");
  writeFileSync(smallPath, "здравей");
  await put(alice.page, smallPath);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 30_000 });
  await bob.page.locator(".transfer").getByRole("button", { name: "Откажи" }).click();
  const told = await alice.page.getByText("Получателят отказа файла.").or(alice.page.getByText("Файлът не беше приет.")).first().innerText({ timeout: 30_000 }).catch(() => "");
  check("a declined file is reported to the sender", told.length > 0, told);
  check("a declined file leaves no card on Bob's side", (await bob.page.locator('[download="note.txt"]').count()) === 0);

  // ---- An HTML file is a download, never a page ----
  const htmlPath = join(dir, "page.html");
  writeFileSync(htmlPath, "<html><body><script>parent.pwned=1</script></body></html>");
  await put(alice.page, htmlPath);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 30_000 });
  await bob.page.locator(".transfer").getByRole("button", { name: "Приеми" }).click();
  const link = bob.page.locator('a.file-download[download="page.html"]');
  await link.waitFor({ timeout: 30_000 });
  const type = await bob.page.evaluate(async () => {
    const a = [...document.querySelectorAll("a.file-download")].find((x) => x.getAttribute("download") === "page.html");
    return (await (await fetch(a.href)).blob()).type;
  });
  check("an HTML file arrives as a plain download (application/octet-stream)", type === "application/octet-stream", type);
  check("no inline frame or page was created", (await bob.page.locator(".messages iframe, .messages object").count()) === 0);

  // ---- Music: a WAV file gets a player with volume − / + ----
  const rate = 8000;
  const samples = rate * 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  const wavPath = join(dir, "tune.wav");
  writeFileSync(wavPath, wav);
  await put(alice.page, wavPath);
  await bob.page.getByText("иска да ти изпрати файл").waitFor({ timeout: 30_000 });
  await bob.page.locator(".transfer").getByRole("button", { name: "Приеми" }).click();
  const player = bob.page.locator(".messages .audio-player");
  await player.waitFor({ timeout: 30_000 });
  check("a music file shows a player, not a download link", (await player.count()) === 1);
  await alice.page.locator(".messages .audio-player").waitFor({ timeout: 30_000 });
  await player.getByRole("button", { name: "По-тихо" }).click();
  await player.getByRole("button", { name: "По-тихо" }).click();
  const vol = await bob.page.evaluate(() => document.querySelector(".audio-player audio").volume);
  check("volume − lowers the sound by 10% a step", Math.abs(vol - 0.8) < 0.001, String(vol));
  await player.getByRole("button", { name: "По-силно" }).click();
  check("volume + raises it again", Math.abs((await bob.page.evaluate(() => document.querySelector(".audio-player audio").volume)) - 0.9) < 0.001);
  await player.getByRole("button", { name: "Пусни" }).click();
  await bob.page.waitForFunction(() => document.querySelector(".audio-player audio").currentTime > 0.1 || !document.querySelector(".audio-player audio").paused, null, { timeout: 15_000 });
  check("the track plays", true);
  await player.getByRole("button", { name: "Пауза" }).click();
  check("and pauses", await bob.page.evaluate(() => document.querySelector(".audio-player audio").paused));

  // ---- Ctrl+V of a picture: staged above the message box, sent on "Send" ----
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const imagesBefore = await bob.page.locator(".messages .msg.in img.msg-image").count();
  await alice.page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await alice.page.locator(".paste-preview img").waitFor({ timeout: 10_000 });
  check("a pasted picture waits above the message box", (await alice.page.locator(".paste-preview").count()) === 1);
  check("nothing is sent before the person confirms", (await bob.page.locator(".messages .msg.in img.msg-image").count()) === imagesBefore);
  await alice.page.getByRole("button", { name: "Изпрати снимката" }).click();
  await bob.page.waitForFunction((n) => document.querySelectorAll(".messages .msg.in img.msg-image").length > n, imagesBefore, { timeout: 30_000 });
  check("the pasted picture arrives after Send", true);
  check("the preview is gone after sending", (await alice.page.locator(".paste-preview").count()) === 0);
  // A text paste is not taken over.
  const textPrevented = await alice.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello");
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check("a text paste is left to the text field", !textPrevented && (await alice.page.locator(".paste-preview").count()) === 0);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  if (pages) {
    for (const [who, p] of Object.entries(pages)) {
      const tail = await p.page.locator(".chat").innerText().catch(() => "");
      console.log(`  diag ${who}: errors=${JSON.stringify(p.errors)} tail="${tail.slice(-300).replace(/\n+/g, " / ")}"`);
    }
  }
  check("files run completed without exception", false, err instanceof Error ? err.message.split("\n").slice(0, 3).join(" / ") : String(err));
} finally {
  rmSync(dir, { recursive: true, force: true });
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
