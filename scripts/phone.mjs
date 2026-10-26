#!/usr/bin/env node
/**
 * Open your local copy of the app on a phone.
 *
 *   npm run phone            build, serve on this computer, open a temporary https address
 *   npm run phone -- --no-build   reuse the existing dist/
 *
 * A phone only gives a web page the camera, passkeys and WebRTC on https (or on localhost).
 * So besides the address in your Wi-Fi network (http, enough to look at the screens), the
 * script starts a Cloudflare "quick tunnel" when `cloudflared` is installed: a random
 * https://….trycloudflare.com address, no account and no token needed. It prints that
 * address and a QR code to scan with the phone camera. Ctrl+C stops everything.
 *
 * The quick tunnel is temporary and its address changes every run. A passkey belongs to one
 * address, so a profile made there is for testing; for daily use install the app from the
 * public site or the Windows package.
 */
import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { preview } from "vite";
import QRCode from "qrcode";

const PORT = Number(process.env.PHONE_PORT ?? 4173);
const args = new Set(process.argv.slice(2));

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

function hasCommand(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0;
}

async function printQr(url) {
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
}

if (!args.has("--no-build")) {
  console.log("==> Building the app (npm run build)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["run", "build"], { stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const server = await preview({ preview: { host: true, port: PORT, strictPort: true }, logLevel: "warn" });
console.log(`\n==> The app runs on this computer: http://localhost:${PORT}/`);
for (const ip of lanAddresses()) console.log(`    Same Wi-Fi (screens only, no camera or passkey): http://${ip}:${PORT}/`);

let tunnel = null;
if (!hasCommand("cloudflared")) {
  console.log(`
==> For camera, passkeys and calls on the phone you need https. Install cloudflared once:
    Windows:  winget install --id Cloudflare.cloudflared
    macOS:    brew install cloudflared
    Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    Then run "npm run phone" again. No Cloudflare account is needed.
    Ctrl+C stops the server.`);
} else {
  console.log("\n==> Opening a temporary https address (Cloudflare quick tunnel)…");
  tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let shown = false;
  const onData = async (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      console.log(`\n    Open on the phone: ${m[0]}\n    Or scan this code with the phone camera:\n`);
      await printQr(m[0]);
      console.log("    The address changes every run. Ctrl+C stops the tunnel and the server.");
    }
  };
  tunnel.stdout.on("data", onData);
  tunnel.stderr.on("data", onData);
  tunnel.on("exit", (code) => {
    if (!shown) console.log(`cloudflared stopped (code ${code}). The local addresses above still work.`);
  });
}

const stop = () => {
  tunnel?.kill();
  server.httpServer.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
