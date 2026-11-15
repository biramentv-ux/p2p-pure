/**
 * Chat features end to end, two real pages: location sharing (fake GPS), and deleting
 * the chat for both sides. Real encrypted channel, no mocks.
 *
 *   npm run test:chat
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

try {
  const { alice, bob } = await connectPair();
  check("chat connected", true);

  await alice.page.locator(".composer input").fill("текст преди локацията");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "текст преди локацията" }).waitFor({ timeout: 30_000 });

  // ---- Location: Alice shares her fix (fake GPS in her context) ----
  await alice.ctx.grantPermissions(["geolocation"], { origin: base });
  await alice.ctx.setGeolocation({ latitude: 42.6977, longitude: 23.3219, accuracy: 8 });
  await alice.page.getByRole("button", { name: "Сподели точната си локация" }).click();
  await bob.page.locator(".msg-location").first().waitFor({ timeout: 30_000 });
  const bobLoc = await bob.page.locator(".msg-location").first().innerText();
  check("location arrives on Bob's side with coordinates and accuracy", bobLoc.includes("42.69770") && bobLoc.includes("23.32190") && bobLoc.includes("±8"), bobLoc.replace(/\n/g, " / "));
  const mapHref = await bob.page.locator(".msg-location a").first().getAttribute("href");
  check("map link points to the shared position", mapHref?.includes("mlat=42.6977") && mapHref?.includes("mlon=23.3219"), mapHref ?? "");
  await alice.page.locator(".msg-location").first().waitFor({ timeout: 10_000 });
  check("Alice sees her own location message", true);

  // Bob shares his location with no permission: he is told, nothing is sent.
  await bob.page.getByRole("button", { name: "Сподели точната си локация" }).click();
  // The position request can take up to 20 s before the browser refuses or times out.
  const denied = await bob.page.locator('[role="alert"]').first().innerText({ timeout: 30_000 }).catch(() => "");
  const bobCount = await bob.page.locator(".msg-location").count();
  const bobNow = (await bob.page.locator(".chat").innerText()).slice(-260).replace(/\n+/g, " / ");
  console.log(`  diag bob: alerts=${JSON.stringify(denied)} locations=${bobCount} tail="${bobNow}"`);
  check("without permission the person is told and nothing is shared", denied.length > 0 && bobCount === 1, denied);

  // ---- Disappearing messages (Н7): Alice turns the timer on, both sides get it ----
  await alice.page.getByRole("button", { name: "Криптография" }).click();
  await alice.page.locator(".timer-row select").selectOption(String(5 * 60 * 1000));
  await alice.page.locator(".status.timer").waitFor({ timeout: 15_000 });
  await bob.page.getByText("Алиса включи изчезващи съобщения: 5 минути.").waitFor({ timeout: 30_000 });
  check("the timer reaches Bob with a notice", (await bob.page.locator(".status.timer").innerText()).includes("5 минути"));
  await alice.page.locator(".composer input").fill("изчезва след 5 минути");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "изчезва след 5 минути" }).waitFor({ timeout: 30_000 });
  const expiries = async (page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("p2p-messenger");
          req.onsuccess = () => {
            const all = req.result.transaction("messages").objectStore("messages").getAll();
            all.onsuccess = () => resolve(all.result.map((r) => (r.expiresAt ? r.expiresAt - r.timestamp : 0)));
          };
        }),
    );
  const bobExp = await expiries(bob.page);
  const aliceExp = await expiries(alice.page);
  check("the new message expires in 5 minutes on both devices", bobExp.at(-1) === 300_000 && aliceExp.at(-1) === 300_000, `${aliceExp.at(-1)} / ${bobExp.at(-1)}`);
  check("older messages keep no expiry", bobExp.slice(0, -1).every((v) => v === 0));
  await alice.page.locator(".timer-row select").selectOption("0");
  await bob.page.getByText("Алиса изключи изчезващите съобщения.").waitFor({ timeout: 30_000 });
  check("turning it off reaches Bob too", (await bob.page.locator(".status.timer").count()) === 0);
  await alice.page.getByRole("button", { name: "Криптография" }).click();

  // ---- Delete chat for both sides ----
  await alice.page.getByRole("button", { name: "Изтрий чата за двамата" }).click();
  await alice.page.getByRole("button", { name: "Не" }).click();
  check("cancelling the delete keeps the chat", (await alice.page.locator(".messages .msg").count()) > 0);

  await alice.page.getByRole("button", { name: "Изтрий чата за двамата" }).click();
  await alice.page.getByRole("button", { name: "Да, изтрий за двамата" }).click();
  await alice.page.locator(".messages .msg").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
  check("Alice's chat is empty after delete", (await alice.page.locator(".messages .msg").count()) === 0);
  await bob.page.getByText("Другият човек изтри чата.").waitFor({ timeout: 30_000 });
  check("Bob's chat is emptied too, with a notice", (await bob.page.locator(".messages .msg").count()) === 0);

  // The chat keeps working for new messages.
  await bob.page.locator(".composer input").fill("нов след изтриването");
  await bob.page.getByRole("button", { name: "Изпрати" }).click();
  await alice.page.locator(".messages .msg.in").filter({ hasText: "нов след изтриването" }).waitFor({ timeout: 30_000 });
  check("messages work again after the wipe", true);

  // ---- Panic wipe (Н7): Bob empties his device from the settings ----
  await bob.page.getByRole("button", { name: "Назад" }).click().catch(() => undefined);
  await bob.page.getByRole("button", { name: "Идентичност" }).click();
  await bob.page.getByText("Защита на устройството").click();
  await bob.page.getByRole("button", { name: "Изтрий всичко от това устройство" }).click();
  await bob.page.getByRole("button", { name: "Да, изтрий всичко" }).click();
  await bob.page.getByRole("button", { name: "Създай идентичност" }).waitFor({ timeout: 30_000 });
  const leftover = await bob.page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("p2p-messenger");
        req.onsuccess = () => {
          const db = req.result;
          const names = Array.from(db.objectStoreNames);
          const tx = db.transaction(names);
          let total = 0;
          let left = names.length;
          for (const n of names) {
            const c = tx.objectStore(n).count();
            c.onsuccess = () => {
              total += c.result;
              if (--left === 0) resolve(total);
            };
          }
        };
      }),
  );
  check("panic wipe leaves no rows and returns to the first screen", leftover === 0, `rows=${leftover}`);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("chat run completed without exception", false, err instanceof Error ? err.message.split("\n").slice(0, 3).join(" / ") : String(err));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
