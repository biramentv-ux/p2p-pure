/**
 * Copies the native overlays into the generated Capacitor projects and applies the
 * few manifest/plist/gradle edits they need. Idempotent.
 *
 *   node scripts/mobile/sync-overlays.mjs           write changes
 *   node scripts/mobile/sync-overlays.mjs --check   exit 1 if anything is out of sync
 *
 * Run `npx cap add android` / `npx cap add ios` first (creates android/ and ios/).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHECK = process.argv.includes("--check");
const problems = [];
const changed = [];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const MEDIA_PERMISSIONS = [
  '    <uses-permission android:name="android.permission.CAMERA" />',
  '    <uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
];
// Lint (PermissionImpliesUnsupportedChromeOsHardware): a permission that implies
// hardware needs a uses-feature tag. required="false" keeps the app installable
// on devices without the hardware (Chrome OS, tablets without a camera).
// П4/П5 experiments: SSDP multicast for UPnP port mapping (NativeNetPlugin) and Wi-Fi Aware
// for the mesh (MeshRadioPlugin). Both idle unless the experiment is turned on in Settings.
const EXPERIMENT_MANIFEST = [
  // П3: notifications (Android 13+) and the foreground service that keeps links up (LinkKeeperService).
  { needle: 'android:name="android.permission.POST_NOTIFICATIONS"', line: '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />' },
  { needle: 'android:name="android.permission.FOREGROUND_SERVICE"', line: '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />' },
  {
    needle: 'android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING"',
    line: '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />',
  },
  { needle: 'android:name="android.permission.WAKE_LOCK"', line: '    <uses-permission android:name="android.permission.WAKE_LOCK" />' },
  {
    needle: 'android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE"',
    line: '    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />',
  },
  {
    needle: 'android:name="android.permission.ACCESS_WIFI_STATE"',
    line: '    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />',
  },
  {
    needle: 'android:name="android.permission.CHANGE_WIFI_STATE"',
    line: '    <uses-permission android:name="android.permission.CHANGE_WIFI_STATE" />',
  },
  {
    needle: 'android:name="android.permission.NEARBY_WIFI_DEVICES"',
    line: '    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" />',
  },
];
const MEDIA_FEATURES = [
  '    <uses-feature android:name="android.hardware.camera" android:required="false" />',
  '    <uses-feature android:name="android.hardware.microphone" android:required="false" />',
];
// Bluetooth Low Energy first-contact pairing (BlePairingPlugin). Android 12+ asks for the
// three BLUETOOTH_* runtime permissions; scanning is declared neverForLocation because the
// app never derives a position from it. Android 11 and older use the legacy pair plus the
// location permission above (already in MEDIA_PERMISSIONS, so it is not repeated here).
// Each entry carries its own needle: a plain name would also match longer names
// ("android.permission.BLUETOOTH" is a prefix of "...BLUETOOTH_SCAN").
const BLE_MANIFEST = [
  {
    needle: 'android:name="android.permission.BLUETOOTH"',
    line: '    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
  },
  {
    needle: 'android:name="android.permission.BLUETOOTH_ADMIN"',
    line: '    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
  },
  {
    needle: 'android:name="android.permission.BLUETOOTH_SCAN"',
    line: '    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />',
  },
  {
    needle: 'android:name="android.permission.BLUETOOTH_ADVERTISE"',
    line: '    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />',
  },
  {
    needle: 'android:name="android.permission.BLUETOOTH_CONNECT"',
    line: '    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
  },
  {
    needle: 'android:name="android.hardware.bluetooth_le"',
    line: '    <uses-feature android:name="android.hardware.bluetooth_le" android:required="false" />',
  },
];
const GRADLE_DEPS = [
  'implementation "androidx.credentials:credentials:1.6.0"',
  'implementation "androidx.credentials:credentials-play-services-auth:1.6.0"',
];
const IOS_USAGE = [
  ["NSCameraUsageDescription", "Камерата се използва, за да сканираш QR код и за видео разговори."],
  ["NSMicrophoneUsageDescription", "Микрофонът се използва за аудио и видео разговори."],
  ["NSLocationWhenInUseUsageDescription", "Локацията се споделя с човека, когото избереш, само когато натиснеш бутона."],
  ["NSBluetoothAlwaysUsageDescription", "Bluetooth се използва, за да размениш поканата с телефон до теб, без да сканираш QR код."],
];

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
  for (const feature of MEDIA_FEATURES) {
    const name = /android:name="([^"]+)"/.exec(feature)[1];
    ensureLine(
      "android/app/src/main/AndroidManifest.xml",
      name,
      '<uses-permission android:name="android.permission.INTERNET" />',
      [feature],
      `manifest feature ${name.split(".").pop()}`,
    );
  }
  for (const perm of MEDIA_PERMISSIONS) {
    const name = /android:name="([^"]+)"/.exec(perm)[1];
    ensureLine(
      "android/app/src/main/AndroidManifest.xml",
      name,
      '<uses-permission android:name="android.permission.INTERNET" />',
      [perm],
      `manifest ${name.split(".").pop()}`,
    );
  }
  ensureLine(
    "android/app/src/main/AndroidManifest.xml",
    'android:name=".LinkKeeperService"',
    "        </activity>",
    [
      "",
      "        <!-- П3: keeps links up with the screen off (docs/NOTIFICATIONS.md). Started only by the user's setting. -->",
      '        <service android:name=".LinkKeeperService" android:exported="false" android:foregroundServiceType="remoteMessaging" />',
    ],
    "manifest LinkKeeperService",
  );
  for (const { needle, line } of EXPERIMENT_MANIFEST) {
    ensureLine(
      "android/app/src/main/AndroidManifest.xml",
      needle,
      '<uses-permission android:name="android.permission.INTERNET" />',
      [line],
      `manifest ${/android:name="[^"]*?([^."]+)"/.exec(needle)[1]}`,
    );
  }
  for (const { needle, line } of BLE_MANIFEST) {
    ensureLine(
      "android/app/src/main/AndroidManifest.xml",
      needle,
      '<uses-permission android:name="android.permission.INTERNET" />',
      [line],
      `manifest ${/android:name="[^"]*?([^."]+)"/.exec(needle)[1]}`,
    );
  }
}

/** Stable 24-hex-digit Xcode object id for an overlay file (same input, same id). */
function xcodeId(kind, name) {
  return crypto.createHash("sha1").update(`p2p-overlay:${kind}:${name}`).digest("hex").slice(0, 24).toUpperCase();
}

/**
 * Copies native-overlays/ios/*.swift into ios/App/App/ and registers each file in the
 * App target of App.xcodeproj (the generated project lists its sources one by one; it has
 * no folder references, so a file that is only copied would not be compiled).
 */
function syncIosSwift() {
  const srcDir = path.join(ROOT, "native-overlays/ios");
  const destDir = path.join(ROOT, "ios/App/App");
  const swiftFiles = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith(".swift"))
    .sort();
  for (const f of swiftFiles) {
    const want = fs.readFileSync(path.join(srcDir, f), "utf8");
    const dest = path.join(destDir, f);
    const have = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
    if (have === want) continue;
    changed.push(`swift: ${f}`);
    if (!CHECK) fs.writeFileSync(dest, want);
  }

  const pbxPath = "ios/App/App.xcodeproj/project.pbxproj";
  if (!fs.existsSync(path.join(ROOT, pbxPath))) {
    problems.push(`${pbxPath} is missing`);
    return;
  }
  let pbx = read(pbxPath);
  const before = pbx;
  const insertAfter = (re, text, label) => {
    if (!re.test(pbx)) {
      problems.push(`xcode project: ${label} not found in ${pbxPath}`);
      return;
    }
    pbx = pbx.replace(re, (m) => m + text);
  };
  for (const f of swiftFiles) {
    const refId = xcodeId("fileref", f);
    const buildId = xcodeId("build", f);
    if (!pbx.includes(`${refId} /* ${f} */ = {isa = PBXFileReference`)) {
      pbx = pbx.replace(
        "/* End PBXFileReference section */",
        `\t\t${refId} /* ${f} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${f}; sourceTree = "<group>"; };\n/* End PBXFileReference section */`,
      );
    }
    if (!pbx.includes(`${buildId} /* ${f} in Sources */ = {isa = PBXBuildFile`)) {
      pbx = pbx.replace(
        "/* End PBXBuildFile section */",
        `\t\t${buildId} /* ${f} in Sources */ = {isa = PBXBuildFile; fileRef = ${refId} /* ${f} */; };\n/* End PBXBuildFile section */`,
      );
    }
    const groupRe = /504EC3061FED79650016851F \/\* App \*\/ = \{\s*isa = PBXGroup;\s*children = \(\n/;
    const groupBlock = /504EC3061FED79650016851F \/\* App \*\/ = \{[\s\S]*?\n\t\t\};/.exec(pbx)?.[0] ?? "";
    if (!groupBlock.includes(`${refId} /* ${f} */,`)) {
      insertAfter(groupRe, `\t\t\t\t${refId} /* ${f} */,\n`, "App group");
    }
    const srcRe = /504EC3001FED79650016851F \/\* Sources \*\/ = \{[\s\S]*?files = \(\n/;
    const srcBlock = /504EC3001FED79650016851F \/\* Sources \*\/ = \{[\s\S]*?\n\t\t\};/.exec(pbx)?.[0] ?? "";
    if (!srcBlock.includes(`${buildId} /* ${f} in Sources */,`)) {
      insertAfter(srcRe, `\t\t\t\t${buildId} /* ${f} in Sources */,\n`, "Sources build phase");
    }
  }
  if (pbx !== before) {
    changed.push(`xcode project sources: ${pbxPath}`);
    if (!CHECK) fs.writeFileSync(path.join(ROOT, pbxPath), pbx);
  }

  // The first screen must be our subclass of Capacitor's bridge controller, which registers
  // BlePairingPlugin (a local plugin is not found by `cap sync`). Only switch when the class
  // exists, otherwise the app would not start.
  const sb = "ios/App/App/Base.lproj/Main.storyboard";
  if (swiftFiles.includes("MainViewController.swift") && fs.existsSync(path.join(ROOT, sb))) {
    const text = read(sb);
    const stock = 'customClass="CAPBridgeViewController" customModule="Capacitor"';
    const ours = 'customClass="MainViewController" customModule="App" customModuleProvider="target"';
    if (!text.includes(ours)) {
      if (!text.includes(stock)) {
        problems.push(`storyboard: CAPBridgeViewController view controller not found in ${sb}`);
      } else {
        changed.push(`storyboard initial view controller: ${sb}`);
        if (!CHECK) fs.writeFileSync(path.join(ROOT, sb), text.replace(stock, ours));
      }
    }
  }
}

function syncIos() {
  const plist = "ios/App/App/Info.plist";
  if (!fs.existsSync(path.join(ROOT, plist))) {
    problems.push("ios/ is missing: run `npx cap add ios` first");
    return;
  }
  let text = read(plist);
  for (const [key, value] of IOS_USAGE) {
    if (text.includes(`<key>${key}</key>`)) continue;
    text = text.replace("<dict>", `<dict>\n\t<key>${key}</key>\n\t<string>${value}</string>`);
    changed.push(`ios usage text ${key}: ${plist}`);
  }
  if (!CHECK) fs.writeFileSync(path.join(ROOT, plist), text);
  syncIosSwift();
}

syncAndroid();
syncIos();

for (const c of changed) console.log(`${CHECK ? "OUT OF SYNC" : "updated"}  ${c}`);
for (const p of problems) console.log(`ERROR  ${p}`);
if (changed.length === 0 && problems.length === 0) console.log("native projects match the overlays");
process.exit(problems.length || (CHECK && changed.length) ? 1 : 0);
