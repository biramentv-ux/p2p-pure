/**
 * Н8 NAT lab: one person. Runs inside a host namespace (ip netns exec nl-hA ...), serves the
 * lab build on 127.0.0.1 there, drives a real browser through the app and answers the
 * controller (run.mjs) over stdin/stdout, one JSON object per line.
 *
 * Commands: {"cmd":"init"} → creates a profile
 *           {"cmd":"offer"} → {"offer": text}
 *           {"cmd":"answer","offer":text} → {"answer": text}
 *           {"cmd":"accept","answer":text} → {}
 *           {"cmd":"outcome","timeoutMs":n} → {"connected":bool,"error":string|null}
 *           {"cmd":"chat","name":s,"send":s,"expect":s} → {"ok":bool}
 *           {"cmd":"quit"}
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium, firefox } from "playwright-core";
import { createSteps } from "./steps.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const DIST = path.resolve(arg("--dist", "dist-natlab"));
const BROWSER = arg("--browser", "chromium");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (!file.startsWith(DIST)) return res.writeHead(403).end();
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    // WebAuthn needs a host name, not an IP address: the app is opened as localhost.
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://localhost:${server.address().port}` }));
  });
}

const { base } = await serve();
const browser =
  BROWSER === "firefox"
    ? await firefox.launch({ executablePath: process.env.FIREFOX_PATH, headless: true, firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false } })
    : await chromium.launch({
        executablePath: process.env.CHROME_PATH,
        headless: true,
        args: ["--no-sandbox", "--disable-features=WebRtcHideLocalIpsWithMdns"],
      });
const ctx = await browser.newContext({ locale: "bg-BG" });
const page = await ctx.newPage();
if (BROWSER !== "firefox") {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
}

const handlers = {
  ...createSteps(page, { base }),
  async quit() {
    await browser.close();
    setTimeout(() => process.exit(0), 50);
    return {};
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const out = await handlers[msg.cmd](msg);
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, ...out }) + "\n");
  } catch (e) {
    // A picture of the screen at the moment it went wrong, for the report.
    if (process.env.NATLAB_SHOTS) await page.screenshot({ path: path.join(process.env.NATLAB_SHOTS, `${msg.cmd}-${Date.now()}.png`) }).catch(() => undefined);
    process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }) + "\n");
  }
});
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
