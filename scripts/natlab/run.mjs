/**
 * Н8 NAT lab runner. Linux only, as root (network namespaces + netfilter), no cloud:
 *
 *   sudo -E node scripts/natlab/run.mjs                 # every scenario
 *   sudo -E node scripts/natlab/run.mjs --only cone-cone,udp-blocked
 *   sudo -E node scripts/natlab/run.mjs --browser-b firefox   (FIREFOX_PATH=...)
 *   sudo -E node scripts/natlab/run.mjs --no-build      (reuse dist-natlab/)
 *
 * For each scenario it builds the network (topology.mjs), starts the lab STUN server in the wan
 * namespace, runs one browser per host namespace (agent.mjs), pairs them with the real QR codes
 * of the app, and checks the outcome: a connection and a message both ways, or the expected
 * diagnosis on both screens. Writes natlab-report.json; exits 1 if any scenario differs.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { hostNamespace, NATIVE_SCENARIOS, needsIpv6, NS, planScenario, SCENARIOS, STUN2_V4, STUN_PORT, STUN_URLS, STUN_V4, STUN_V6, teardown } from "./topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = path.join(ROOT, "dist-natlab");
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (process.platform !== "linux" || process.getuid?.() !== 0) {
  console.error("The NAT lab needs Linux and root (network namespaces). Try: sudo -E node scripts/natlab/run.mjs");
  process.exit(2);
}
for (const tool of ["ip", "iptables"]) {
  if (spawnSync("which", [tool]).status !== 0) {
    console.error(`Missing ${tool}. On Debian/Ubuntu: apt-get install iproute2 iptables`);
    process.exit(2);
  }
}

// The UI messages each diagnosis shows (the lab checks the screen text, not internals). Node 22.18+
// strips the TypeScript types itself; network.ts has no imports.
const { describeFailure } = await import(path.join(ROOT, "src/p2p/network.ts"));

function sh(cmd, { allowFail = false } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd.join(" ")}\n${r.stderr}`);
  return r;
}

function netemAvailable() {
  sh(["ip", "netns", "add", "nl-probe"], { allowFail: true });
  const ok = sh(["ip", "netns", "exec", "nl-probe", "tc", "qdisc", "add", "dev", "lo", "root", "netem", "delay", "1ms"], { allowFail: true }).status === 0;
  sh(["ip", "netns", "del", "nl-probe"], { allowFail: true });
  return ok;
}

function ipv6Available() {
  return fs.existsSync("/proc/sys/net/ipv6");
}

class Agent {
  constructor(side, browser) {
    this.side = side;
    this.next = 1;
    this.waiting = new Map();
    this.proc = spawn("ip", ["netns", "exec", hostNamespace(side), process.execPath, path.join(HERE, "agent.mjs"), "--dist", DIST, "--browser", browser], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    this.ready = new Promise((resolve, reject) => {
      this.proc.once("exit", (code) => reject(new Error(`agent ${side} exited ${code}`)));
      readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.ready) return resolve();
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        if (m.ok) w.resolve(m);
        else w.reject(new Error(`${side}: ${m.error}`));
      });
    });
  }
  call(cmd, args = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }
  async quit() {
    try {
      await Promise.race([this.call("quit"), new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      this.proc.kill("SIGKILL");
    }
  }
}

async function runScenario(s, { netem, ipv6, browserA, browserB }) {
  for (const c of teardown()) sh(c, { allowFail: true });
  for (const c of planScenario(s, { netem, ipv6 })) sh(c);
  const stunArgs = ["--host", STUN_V4, "--port", String(STUN_PORT), ...(ipv6 ? ["--host6", STUN_V6] : [])];
  const stun = spawn("ip", ["netns", "exec", NS.wan, process.execPath, path.join(HERE, "stun.mjs"), ...stunArgs], { stdio: "ignore" });
  const a = new Agent("A", browserA);
  const b = new Agent("B", browserB);
  const started = Date.now();
  const result = { name: s.name, note: s.note ?? "", expected: s.expect, connected: null, errorA: null, errorB: null, ok: false, detail: "" };
  try {
    await Promise.all([a.ready, b.ready]);
    await Promise.all([a.call("init"), b.call("init")]);
    const { offer } = await a.call("offer");
    const { answer } = await b.call("answer", { offer });
    await a.call("accept", { answer });
    const [oa, ob] = await Promise.all([a.call("outcome", { timeoutMs: 80_000 }), b.call("outcome", { timeoutMs: 80_000 })]);
    result.connected = oa.connected && ob.connected;
    result.errorA = oa.error;
    result.errorB = ob.error;
    if (s.expect.connect) {
      if (result.connected) {
        await Promise.all([
          a.call("chat", { name: "Боб", send: `здравей от A (${s.name})`, expect: `здравей от B (${s.name})`, waitMs: s.impair ? 60_000 : 30_000 }),
          b.call("chat", { name: "Ани", send: `здравей от B (${s.name})`, expect: `здравей от A (${s.name})`, waitMs: s.impair ? 60_000 : 30_000 }),
        ]);
        result.ok = true;
      } else result.detail = "expected a connection";
    } else {
      const wantA = describeFailure(s.expect.causeA);
      const wantB = describeFailure(s.expect.causeB);
      const okA = !oa.connected && (oa.error ?? "").includes(wantA);
      const okB = !ob.connected && (ob.error ?? "").includes(wantB);
      result.ok = okA && okB;
      if (!result.ok) result.detail = `expected A: "${s.expect.causeA}", B: "${s.expect.causeB}"`;
    }
  } catch (e) {
    result.detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    await Promise.allSettled([a.quit(), b.quit()]);
    stun.kill("SIGKILL");
    for (const c of teardown()) sh(c, { allowFail: true });
  }
  return result;
}

/** П4: two Node processes (the shells' UDP part) punch through and exchange messages. */
async function runNative(s, { netem }) {
  for (const c of teardown()) sh(c, { allowFail: true });
  for (const c of planScenario(s, { netem, ipv6: false })) sh(c);
  const stuns = [STUN_V4, STUN2_V4].map((host) =>
    spawn("ip", ["netns", "exec", NS.wan, process.execPath, path.join(HERE, "stun.mjs"), "--host", host, "--port", String(STUN_PORT)], { stdio: "ignore" }),
  );
  await new Promise((r) => setTimeout(r, 500));
  const started = Date.now();
  const procs = ["A", "B"].map((side) =>
    spawn("ip", ["netns", "exec", hostNamespace(side), process.execPath, path.join(HERE, "native.mjs"), "--side", side, "--stun", `${STUN_V4}:${STUN_PORT},${STUN2_V4}:${STUN_PORT}`], {
      stdio: ["pipe", "pipe", "inherit"],
    }),
  );
  const lines = procs.map((p) => {
    const rl = readline.createInterface({ input: p.stdout });
    const queue = [];
    const waiters = [];
    rl.on("line", (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return;
      }
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  });
  const result = { name: s.name, expected: s.expect, ok: false, detail: "" };
  try {
    const [ea, eb] = await Promise.all(lines.map((next) => next()));
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    procs[0].stdin.write(JSON.stringify({ peer: eb.endpoint, secret }) + "\n");
    procs[1].stdin.write(JSON.stringify({ peer: ea.endpoint, secret }) + "\n");
    const [ra, rb] = await Promise.race([
      Promise.all(lines.map((next) => next())),
      new Promise((_, rej) => setTimeout(() => rej(new Error("no result in 120 s")), 120_000)),
    ]);
    result.natA = ea.endpoint.nat;
    result.natB = eb.endpoint.nat;
    result.connected = ra.result.ok && rb.result.ok;
    result.strategy = ra.result.strategy;
    result.punchMs = Math.max(ra.result.punchMs ?? 0, rb.result.punchMs ?? 0);
    result.errorA = ra.result.error ?? null;
    result.errorB = rb.result.error ?? null;
    result.ok = s.expect.connect ? result.connected && result.strategy === s.expect.strategy : !ra.result.ok && !rb.result.ok;
    if (!result.ok) result.detail = `A: ${JSON.stringify(ra.result)} B: ${JSON.stringify(rb.result)}`;
  } catch (e) {
    result.detail = e instanceof Error ? e.message : String(e);
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    for (const p of procs) p.kill("SIGKILL");
    for (const p of stuns) p.kill("SIGKILL");
    for (const c of teardown()) sh(c, { allowFail: true });
  }
  return result;
}

const nativeOnly = argv.includes("--native-only");
if (!nativeOnly && (!argv.includes("--no-build") || !fs.existsSync(DIST))) {
  console.log("Building the lab version (local STUN, QR decoder exposed)...");
  const r = spawnSync("npx", ["vite", "build", "--outDir", DIST, "--emptyOutDir"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, VITE_STUN_URLS: STUN_URLS, VITE_NATLAB: "1" },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const only = opt("--only")?.split(",");
const list = nativeOnly ? [] : SCENARIOS.filter((s) => !only || only.includes(s.name));
const nativeList = argv.includes("--no-native") ? [] : NATIVE_SCENARIOS.filter((s) => !only || only.includes(s.name));
const netem = netemAvailable();
const ipv6 = ipv6Available();
const browserA = opt("--browser-a") ?? opt("--browser") ?? "chromium";
const browserB = opt("--browser-b") ?? opt("--browser") ?? "chromium";
console.log(
  `NAT lab: ${list.length + nativeList.length} scenarios, ${browserA} ↔ ${browserB}, netem ${netem ? "yes" : "no (loss via netfilter, no delay)"}, IPv6 ${ipv6 ? "yes" : "no (IPv6 scenarios skipped)"}`,
);

const results = [];
for (const s of list) {
  process.stdout.write(`  ${s.name.padEnd(22)} `);
  if (!ipv6 && needsIpv6(s)) {
    results.push({ name: s.name, skipped: "no IPv6 in this kernel", ok: true });
    console.log("SKIP  (no IPv6 in this kernel)");
    continue;
  }
  let r = await runScenario(s, { netem, ipv6, browserA, browserB });
  // A stall (no connection and no message on either screen) is retried once, as in the other
  // e2e tests: headless Chromium sometimes never starts ICE. A wrong outcome is never retried.
  if (!r.ok && r.connected === false && !r.errorA && !r.errorB) {
    r = { ...(await runScenario(s, { netem, ipv6, browserA, browserB })), attempts: 2 };
  }
  results.push(r);
  const outcome = r.connected ? "connected" : "failed";
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${outcome.padEnd(9)} ${String(r.seconds).padStart(3)} s${r.detail ? "  — " + r.detail : ""}`);
}
for (const s of nativeList) {
  process.stdout.write(`  ${s.name.padEnd(34)} `);
  const r = await runNative(s, { netem });
  results.push(r);
  const how = r.connected ? `connected (${r.strategy}, punch ${(r.punchMs / 1000).toFixed(1)} s)` : "no path";
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${how}  NAT ${r.natA}/${r.natB}${r.detail ? "  — " + r.detail : ""}`);
}
fs.writeFileSync(path.join(ROOT, "natlab-report.json"), JSON.stringify({ date: new Date().toISOString(), netem, browserA, browserB, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.skipped).length;
console.log(`${results.length - failed - skipped}/${results.length} scenarios as expected${skipped ? `, ${skipped} skipped` : ""}. Report: natlab-report.json`);
process.exit(failed ? 1 : 0);
