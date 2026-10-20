/**
 * Copies the native overlays into the generated Capacitor projects and applies the
 * few manifest/plist/gradle edits they need. Idempotent.
 *
 *   node scripts/mobile/sync-overlays.mjs           write changes
 *   node scripts/mobile/sync-overlays.mjs --check   exit 1 if anything is out of sync
 *
 * Run `npx cap add android` / `npx cap add ios` first (creates android/ and ios/).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = process.argv.includes("--check");
const problems = [];
const changed = [];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CAMERA_PERMISSION = '    <uses-permission android:name="android.permission.CAMERA" />';
const GRADLE_DEPS = [
  'implementation "androidx.credentials:credentials:1.6.0"',
  'implementation "androidx.credentials:credentials-play-services-auth:1.6.0"',
];
const CAMERA_KEY = "NSCameraUsageDescription";
const CAMERA_TEXT = "Камерата се използва, за да сканираш QR код за свързване с контакт.";

/** Copies native-overlays/android/java/** to android/app/src/main/java/**. */
function syncJava() {
  const srcRoot = path.join(ROOT, "native-overlays/android/java");
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  })(srcRoot);
  for (const src of files) {
    const rel = path.relative(srcRoot, src);
    const dest = path.join(ROOT, "android/app/src/main/java", rel);
    const want = fs.readFileSync(src, "utf8");
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (have === want) continue;
    changed.push(`java: ${rel}`);
    if (!CHECK) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, want);
    }
  }
}

/** Adds a line to a file after an anchor line, unless the needle is already there. */
function ensureLine(file, needle, anchor, lines, label) {
  const full = path.join(ROOT, file);
  let text = fs.readFileSync(full, "utf8");
  if (text.includes(needle)) return;
  const idx = text.indexOf(anchor);
  if (idx < 0) {
    problems.push(`${label}: anchor not found in ${file}`);
    return;
  }
  const insertAt = text.indexOf("\n", idx) + 1;
  text = text.slice(0, insertAt) + lines.join("\n") + "\n" + text.slice(insertAt);
  changed.push(`${label}: ${file}`);
  if (!CHECK) fs.writeFileSync(full, text);
}

function syncAndroid() {
  if (!fs.existsSync(path.join(ROOT, "android/app/build.gradle"))) {
    problems.push("android/ is missing: run `npx cap add android` first");
    return;
  }
  syncJava();
  ensureLine(
    "android/app/build.gradle",
    GRADLE_DEPS[0],
    "implementation project(':capacitor-android')",
    GRADLE_DEPS.map((d) => "    " + d),
    "gradle deps",
  );
  ensureLine(
    "android/app/src/main/AndroidManifest.xml",
    "android.permission.CAMERA",
    "<uses-permission android:name=\"android.permission.INTERNET\" />",
    [CAMERA_PERMISSION],
    "manifest camera",
  );
}

function syncIos() {
  const plist = "ios/App/App/Info.plist";
  if (!fs.existsSync(path.join(ROOT, plist))) {
    problems.push("ios/ is missing: run `npx cap add ios` first");
    return;
  }
  const text = read(plist);
  if (text.includes(CAMERA_KEY)) return;
  const insert = `\t<key>${CAMERA_KEY}</key>\n\t<string>${CAMERA_TEXT}</string>`;
  const next = text.replace("<dict>", "<dict>\n" + insert);
  changed.push(`ios camera usage: ${plist}`);
  if (!CHECK) fs.writeFileSync(path.join(ROOT, plist), next);
}

syncAndroid();
syncIos();

for (const c of changed) console.log(`${CHECK ? "OUT OF SYNC" : "updated"}  ${c}`);
for (const p of problems) console.log(`ERROR  ${p}`);
if (changed.length === 0 && problems.length === 0) console.log("native projects match the overlays");
process.exit(problems.length || (CHECK && changed.length) ? 1 : 0);
