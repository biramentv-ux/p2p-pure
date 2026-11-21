/**
 * Н8 device farm: 3–5 used phones on a desk, no cloud. Installs a build and runs the pairing
 * scenario on real hardware and real networks (each phone on its own Wi-Fi or mobile data).
 *
 *   node scripts/devicefarm/farm.mjs list
 *   node scripts/devicefarm/farm.mjs install --apk android/app/build/outputs/apk/debug/app-debug.apk [--ios-app build/App.app]
 *   node scripts/devicefarm/farm.mjs run [--pair "pixel-a,galaxy-b"] [--dry-run]
 *
 * Phones are listed in scripts/devicefarm/farm.json (copy farm.example.json). Android is driven
 * end to end: the app's WebView is reached over the Chrome DevTools protocol (adb forward), and
 * the same steps as the NAT lab pair two phones and exchange a message. That needs a debug build
 * made with VITE_NATLAB=1 (see docs/DEVICE-FARM.md). iPhones are installed and launched with
 * `xcrun devicectl` (macOS, Xcode 15+); WebKit has no CDP, so their part of a run is the manual
 * checklist (docs/RELEASE-CHECKLIST-RADIO.md), and the report says so.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ID = "bg.p2pmessenger.app";

/** `adb devices -l` → [{ serial, state, model }] */
export function parseAdbDevices(text) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline|recovery|sideload)\b(.*)$/);
    if (!m) continue;
    const model = m[3].match(/model:(\S+)/)?.[1] ?? "";
    out.push({ serial: m[1], state: m[2], model });
  }
  return out;
}

/** `xcrun devicectl list devices --json-output f` → [{ udid, name, os }] */
export function parseDevicectl(json) {
  const list = json?.result?.devices ?? [];
  return list.map((d) => ({
    udid: d.hardwareProperties?.udid ?? d.identifier,
    name: d.deviceProperties?.name ?? "",
    os: d.deviceProperties?.osVersionNumber ?? "",
  }));
}

/** The WebView DevTools sockets in `adb shell cat /proc/net/unix`, newest pid last. */
export function webviewSockets(procNetUnix) {
  const found = new Set();
  for (const m of procNetUnix.matchAll(/@(webview_devtools_remote_\d+|chrome_devtools_remote)\b/g)) found.add(m[1]);
  return [...found];
}

/** The commands for one phone (no shell; tested without devices). */
export function installCommands(device, { apk, iosApp }) {
  if (device.platform === "android") {
    if (!apk) return [];
    return [["adb", "-s", device.serial, "install", "-r", "-g", apk]];
  }
  if (device.platform === "ios") {
    if (!iosApp) return [];
    return [["xcrun", "devicectl", "device", "install", "app", "--device", device.udid, iosApp]];
  }
  return [];
}

export function launchCommands(device) {
  if (device.platform === "android") {
    return [
      ["adb", "-s", device.serial, "shell", "am", "force-stop", APP_ID],
      ["adb", "-s", device.serial, "shell", "pm", "clear", APP_ID], // a fresh profile for every run
      ["adb", "-s", device.serial, "shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"],
    ];
  }
  if (device.platform === "ios") {
    return [["xcrun", "devicectl", "device", "process", "launch", "--terminate-existing", "--device", device.udid, APP_ID]];
  }
  return [];
}

export function loadFarm(file = path.join(HERE, "farm.json")) {
  if (!fs.existsSync(file)) throw new Error(`No ${path.relative(process.cwd(), file)}. Copy farm.example.json and list your phones.`);
  const farm = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const d of farm.devices ?? []) {
    if (!d.name || !["android", "ios"].includes(d.platform)) throw new Error(`Bad device entry: ${JSON.stringify(d)}`);
    if (d.platform === "android" && !d.serial) throw new Error(`${d.name}: android needs "serial" (adb devices)`);
    if (d.platform === "ios" && !d.udid) throw new Error(`${d.name}: ios needs "udid" (xcrun devicectl list devices)`);
  }
  return farm;
}

function run(cmd, { dry, allowFail = false } = {}) {
  console.log(`  $ ${cmd.join(" ")}`);
  if (dry) return { status: 0, stdout: "" };
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

/** Connects to the app's WebView on an Android phone and returns its page. */
async function androidPage(device, localPort) {
  const { chromium } = await import("playwright-core");
  let socket = null;
  for (let i = 0; i < 30 && !socket; i++) {
    const unix = run(["adb", "-s", device.serial, "shell", "cat", "/proc/net/unix"], { allowFail: true }).stdout ?? "";
    socket = webviewSockets(unix).filter((s) => s.startsWith("webview")).at(-1) ?? null;
    if (!socket) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!socket) throw new Error(`${device.name}: no WebView DevTools socket. Is it a debug build?`);
  run(["adb", "-s", device.serial, "forward", `tcp:${localPort}`, `localabstract:${socket}`]);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${localPort}`);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error(`${device.name}: the WebView has no page`);
  return { browser, page };
}

async function pairAndroid(a, b) {
  const { createSteps } = await import("../natlab/steps.mjs");
  const [pa, pb] = await Promise.all([androidPage(a, 9301), androidPage(b, 9302)]);
  const A = createSteps(pa.page, { base: null });
  const B = createSteps(pb.page, { base: null });
  const started = Date.now();
  try {
    await Promise.all([A.init(), B.init()]);
    const { offer } = await A.offer();
    const { answer } = await B.answer({ offer });
    await A.accept({ answer });
    const [oa, ob] = await Promise.all([A.outcome({ timeoutMs: 90_000 }), B.outcome({ timeoutMs: 90_000 })]);
    if (oa.connected && ob.connected) {
      await Promise.all([
        A.chat({ name: b.name, send: `здравей от ${a.name}`, expect: `здравей от ${b.name}` }),
        B.chat({ name: a.name, send: `здравей от ${b.name}`, expect: `здравей от ${a.name}` }),
      ]);
    }
    return { pair: `${a.name} ↔ ${b.name}`, connected: oa.connected && ob.connected, errorA: oa.error, errorB: ob.error, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    await Promise.allSettled([pa.browser.close(), pb.browser.close()]);
  }
}

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dry = argv.includes("--dry-run");
  const cmd = argv[0];
  if (cmd === "list") {
    const adb = spawnSync("adb", ["devices", "-l"], { encoding: "utf8" });
    console.log("Android:", adb.status === 0 ? parseAdbDevices(adb.stdout) : "adb not found");
    if (process.platform === "darwin") {
      const f = path.join(HERE, ".devicectl.json");
      const r = spawnSync("xcrun", ["devicectl", "list", "devices", "--json-output", f], { encoding: "utf8" });
      console.log("iOS:", r.status === 0 ? parseDevicectl(JSON.parse(fs.readFileSync(f, "utf8"))) : "devicectl not available");
    }
    return;
  }
  const farm = loadFarm(opt("--farm"));
  if (cmd === "install") {
    for (const d of farm.devices) {
      console.log(`${d.name} (${d.platform} ${d.os ?? ""})`);
      for (const c of installCommands(d, { apk: opt("--apk"), iosApp: opt("--ios-app") })) run(c, { dry });
    }
    return;
  }
  if (cmd === "run") {
    const names = opt("--pair")?.split(",");
    const androids = farm.devices.filter((d) => d.platform === "android" && (!names || names.includes(d.name)));
    for (const d of farm.devices) for (const c of launchCommands(d)) run(c, { dry });
    const report = { date: new Date().toISOString(), automated: [], manual: [] };
    if (!dry) {
      for (let i = 0; i + 1 < androids.length; i += 2) {
        const r = await pairAndroid(androids[i], androids[i + 1]).catch((e) => ({ pair: `${androids[i].name} ↔ ${androids[i + 1].name}`, connected: false, error: e.message }));
        console.log(`${r.connected ? "PASS" : "FAIL"}  ${r.pair}${r.error ? "  — " + r.error : ""}`);
        report.automated.push(r);
      }
    }
    for (const d of farm.devices.filter((x) => x.platform === "ios")) {
      report.manual.push({ device: d.name, os: d.os, todo: "docs/RELEASE-CHECKLIST-RADIO.md (QR, BLE, sound, light)" });
    }
    fs.writeFileSync("devicefarm-report.json", JSON.stringify(report, null, 2));
    console.log("Report: devicefarm-report.json");
    if (report.automated.some((r) => !r.connected)) process.exitCode = 1;
    return;
  }
  console.log("Usage: farm.mjs list | install --apk <apk> [--ios-app <App.app>] | run [--pair a,b] [--dry-run]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
