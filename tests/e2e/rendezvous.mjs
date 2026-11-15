/**
 * Н2 end to end: two real pages become verified contacts by QR, both turn on "find over the
 * internet", and later Alice reaches Bob through a local Nostr relay (no QR, no code). The
 * relay must see only ciphertext.
 *
 *   node tests/e2e/rendezvous.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { startNostrRelay } from "./nostrRelay.mjs";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "dolga parola 2026";
setTimeout(() => {
  console.error("WATCHDOG: aborting after 400s");
  process.exit(2);
}, 400_000).unref();

const relay = await startNostrRelay();
process.env.VITE_NOSTR_RELAYS = relay.url;
const server = await createServer({ server: { port: 0, host: "localhost" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"],
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


async function turnOn(page) {
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Идентичност" }).click();
  await page.getByText("Откриване през интернет").click();
  await page.getByLabel("Намирай познатите ми контакти без нов QR (през публични Nostr релета)").check();
}

try {
  const { alice, bob } = await connectPair();
  check("verified contacts by QR", true);
  await turnOn(alice.page);
  await turnOn(bob.page);
  check("both turned on finding over the internet", true);

  await alice.page.getByRole("button", { name: "Контакти" }).click();
  await alice.page.getByRole("button", { name: "Чат", exact: true }).first().click();
  const t0 = Date.now();
  await alice.page.getByRole("button", { name: "Намери Боб през интернет" }).click();
  await bob.page.getByText("те търси през интернет.").waitFor({ timeout: 60_000 });
  check("Bob is told that Alice is looking for him", (await bob.page.locator(".rv-banner").innerText()).includes("Алиса"));
  await bob.page.locator(".rv-banner").getByRole("button", { name: "Свържи се" }).click();
  await alice.page.locator(".chat").waitFor({ timeout: 60_000 });
  await bob.page.locator(".chat").waitFor({ timeout: 60_000 });
  check("both are in the chat without a QR or a code", (await alice.page.locator(".safety-code").count()) === 0, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await alice.page.locator(".composer input").fill("намерих те през интернет");
  await alice.page.getByRole("button", { name: "Изпрати" }).click();
  await bob.page.locator(".messages .msg.in").filter({ hasText: "намерих те през интернет" }).waitFor({ timeout: 30_000 });
  check("an encrypted message arrives over the new link", true);

  const wire = JSON.stringify(relay.events);
  const dids = await Promise.all([alice.page, bob.page].map((p) => p.evaluate(() => document.querySelector(".did-text")?.textContent ?? "")));
  check("the relay saw events", relay.events.length >= 2, String(relay.events.length));
  check("the relay saw no invitation, SDP or name", !/p2p1:|a=fingerprint|candidate|Алиса|Боб/.test(wire));
  check("the relay saw no did", dids.every((d) => !d || !wire.includes(d)));
  check("every event has its own author key", new Set(relay.events.map((e) => e.pubkey)).size === relay.events.length);

  check("no page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
  check("no page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
} catch (err) {
  check("rendezvous run completed without exception", false, err instanceof Error ? err.message.split("\n").slice(0, 3).join(" / ") : String(err));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
  await relay.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
