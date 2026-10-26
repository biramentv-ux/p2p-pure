/**
 * End-to-end check with two independent Chromium pages, each running the
 * app's real P2P code over a real WebRTC data channel:
 *   invitation (QR round-trip) -> signed handshake -> safety code ->
 *   encrypted messages both ways -> ciphertext on the wire -> replay rejected.
 *
 *   npm run test:e2e
 *
 * In sandboxes where outbound traffic goes through a proxy, run with the
 * proxy variables removed for the browser (see README in the project notes).
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";

const CHROME_PATH =
  process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const T0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => {
  console.error("WATCHDOG: aborting after 200s");
  process.exit(2);
}, 200_000).unref();

const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const url = `${base}/tests/e2e/harness/index.html`;

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

/** Polls a page-side value until it satisfies `pred` or times out. */
async function waitUntil(fn, pred, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  const ctx = await browser.newContext({ locale: "bg-BG" });
  const alice = await ctx.newPage(); // initiator
  const bob = await ctx.newPage(); // responder
  const pageErrors = [];
  for (const p of [alice, bob]) {
    p.on("pageerror", (e) => pageErrors.push(e.message));
    p.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
    await p.goto(url);
    await p.waitForFunction(() => window.harness !== undefined, null, { timeout: 30_000 });
  }
  log("pages ready");

  const aliceDid = await alice.evaluate(() => window.harness.did);
  const bobDid = await bob.evaluate(() => window.harness.did);
  check("identities differ", aliceDid !== bobDid);

  // 1. Invitation and QR transport
  const offerPayload = await alice.evaluate(() => window.harness.makeOffer());
  check("offer invitation fits a QR code", offerPayload.length < 1500, `${offerPayload.length} chars`);
  check(
    "offer survives QR render -> jsQR decode",
    await bob.evaluate((p) => window.harness.qrRoundTrip(p), offerPayload),
  );

  // 2. Responder answers
  const { payload: answerPayload, peerDid } = await bob.evaluate(
    (p) => window.harness.makeAnswer(p),
    offerPayload,
  );
  check("responder sees the correct initiator did", peerDid === aliceDid);
  check(
    "answer survives QR render -> jsQR decode",
    await alice.evaluate((p) => window.harness.qrRoundTrip(p), answerPayload),
  );

  // 3. Handshake both ways
  const [aliceSeesBob, bobSeesAlice] = await Promise.all([
    alice.evaluate((p) => window.harness.acceptAnswer(p), answerPayload),
    bob.evaluate(() => window.harness.awaitResponderHandshake()),
  ]);
  check("initiator verified responder did via hello", aliceSeesBob === bobDid);
  check("responder verified initiator did via hello", bobSeesAlice === aliceDid);

  // 4. Safety code must match on both screens
  const aliceCode = await alice.evaluate(() => window.harness.safetyCode());
  const bobCode = await bob.evaluate(() => window.harness.safetyCode());
  check("safety code is identical on both devices", aliceCode === bobCode, aliceCode);
  check("safety code has 12 words", aliceCode.split(/ · |\n/).length === 12);

  // 5. Encrypted messages both ways
  const secret = "тайна: паролата е 42-tango";
  const wire = await alice.evaluate((t) => window.harness.sendSecure(t), secret);
  check("wire message does not contain the plaintext", !wire.includes("тайна") && !wire.includes("tango"));
  const bobGot = await waitUntil(
    () => bob.evaluate(() => window.harness.receivedTexts()),
    (arr) => arr.length >= 1,
  );
  check("responder decrypts the initiator's message", bobGot[0] === secret, JSON.stringify(bobGot));

  await bob.evaluate((t) => window.harness.sendSecure(t), "ок, получих го");
  const aliceGot = await waitUntil(
    () => alice.evaluate(() => window.harness.receivedTexts()),
    (arr) => arr.length >= 1,
  );
  check("initiator decrypts the reply", aliceGot[0] === "ок, получих го", JSON.stringify(aliceGot));

  // 6. Replay of an old ciphertext on the live channel must be rejected
  await alice.evaluate(() => window.harness.replayLast());
  const errs = await waitUntil(
    () => bob.evaluate(() => window.harness.securityErrors()),
    (arr) => arr.length >= 1,
  );
  check("replayed ciphertext is rejected", errs.length === 1 && /counter/.test(errs[0]), errs.join(" | "));
  check("replay did not add a plaintext message", (await bob.evaluate(() => window.harness.receivedTexts())).length === 1);

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  check("e2e run completed without exception", false, err instanceof Error ? err.message : String(err));
} finally {
  log("closing");
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]);
  await Promise.race([server.close(), new Promise((r) => setTimeout(r, 5_000))]);
  log("closed");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
