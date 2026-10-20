/**
 * Release readiness for the mobile packages. Prints what is done and what is still
 * blocked by values only the owner can provide. Exit code 0 only when nothing is blocked.
 *
 *   npm run mobile:check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), "utf8") : "");
const blocked = [];
const done = [];

const ok = (msg) => done.push(msg);
const block = (msg) => blocked.push(msg);

if (fs.existsSync(path.join(ROOT, "dist/index.html"))) ok("web build exists (dist/)");
else block("web build missing: run `npm run build`");

if (fs.existsSync(path.join(ROOT, "android/app/build.gradle"))) ok("Android project generated (android/)");
else block("Android project missing: `npx cap add android`");

if (fs.existsSync(path.join(ROOT, "ios/App/App/Info.plist"))) ok("iOS project generated (ios/)");
else block("iOS project missing: `npx cap add ios` (needs a Mac with Xcode to build)");

if (/REPLACE_WITH_SHA256_FINGERPRINT/.test(read("public/.well-known/assetlinks.json"))) {
  block("Android signing SHA-256 is a placeholder in public/.well-known/assetlinks.json (owner: from the release keystore)");
} else ok("assetlinks.json has a real fingerprint");

if (/TEAMID/.test(read("public/.well-known/apple-app-site-association"))) {
  block("Apple Team ID is a placeholder in public/.well-known/apple-app-site-association (owner: Apple Developer account)");
} else ok("apple-app-site-association has a real Team ID");

const sync = path.join(ROOT, "scripts/mobile/sync-overlays.mjs");
if (fs.existsSync(path.join(ROOT, "android/app/build.gradle")) || fs.existsSync(path.join(ROOT, "ios/App/App/Info.plist"))) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [sync, "--check"], { encoding: "utf8" });
  if (r.status === 0) ok("native projects match the overlays");
  else block("native projects differ from the overlays: `node scripts/mobile/sync-overlays.mjs`");
}

console.log("Done:");
for (const m of done) console.log("  ✔ " + m);
console.log("Blocked:");
for (const m of blocked) console.log("  ✖ " + m);
process.exit(blocked.length ? 1 : 0);
