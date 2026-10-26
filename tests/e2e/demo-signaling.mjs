/**
 * Browser check of the demo signalling mode: two pages join one room on the relay, exchange the
 * signed offer and answer through it, complete the real WebRTC handshake, and exchange an
 * encrypted message. A third page must be refused because the room is full.
 *
 *   npm run test:demo
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { startDemoRelay } from "./demoRelay.mjs";

const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => {
  console.error("WATCHDOG: aborting after 200s");
  process.exit(2);
}, 200_000).unref();

const vite = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await vite.listen();
const base = vite.resolvedUrls.local[0].replace(/\/$/, "");
const url = `${base}/tests/e2e/harness/index.html`;
const relay = await startDemoRelay(vite);

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

try {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const host = await ctx.newPage();
  const guest = await ctx.newPage();
  const extra = await ctx.newPage();
  const pageErrors = [];
  for (const p of [host, guest, extra]) {
    p.on("pageerror", (e) => pageErrors.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => window.harness !== undefined, null, { timeout: 30_000 });
  }
  log("pages ready");

  const code = await host.evaluate((b) => window.harness.demoHost(b), relay.url);
  check("host gets a 10-character room code", /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/.test(code), code);

  const [guestPeer, hostPeer] = await Promise.all([
    guest.evaluate(([b, c]) => window.harness.demoGuest(b, c), [relay.url, code]),
    host.evaluate(() => window.harness.demoHostFinish()),
  ]);
  const hostDid = await host.evaluate(() => window.harness.did);
  const guestDid = await guest.evaluate(() => window.harness.did);
  check("guest verified the host's did through the room", guestPeer === hostDid);
  check("host verified the guest's did through the room", hostPeer === guestDid);

  const [hostCode, guestCode] = await Promise.all([
    host.evaluate(() => window.harness.safetyCode()),
    guest.evaluate(() => window.harness.safetyCode()),
  ]);
  check("safety code is identical on both devices", hostCode === guestCode && hostCode.split(" · ").length === 6, hostCode);

  const secret = "тайна през стаята";
  await host.evaluate((text) => window.harness.sendSecure(text), secret);
  let got = [];
  for (let i = 0; i < 50; i++) {
    got = await guest.evaluate(() => window.harness.receivedTexts());
    if (got.includes(secret)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check("guest decrypts the host's message", got.includes(secret), JSON.stringify(got));
  check("the relay never saw the message text", !relay.frames.join("").includes("тайна"));

  let refused = false;
  try {
    await extra.evaluate(([b, c]) => window.harness.demoGuest(b, c), [relay.url, code]);
  } catch {
    refused = true;
  }
  check("a third device is refused: the room is full", refused);

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  check("demo flow completed without an exception", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  await relay.close();
  await vite.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
