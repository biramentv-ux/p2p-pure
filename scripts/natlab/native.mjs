/**
 * П4 lab: the native transport over real Linux NATs. Two Node processes (the part of the
 * desktop and Android shells that owns UDP sockets) in the host namespaces of a lab scenario:
 * STUN to two servers (public endpoint and NAT kind), hole punching (birthday punching for cone
 * against symmetric), then the encrypted datagram link with messages and a 300 KB binary.
 *
 * Started by run.mjs for the NATIVE_SCENARIOS (topology.mjs), one process per side:
 *   ip netns exec nl-hA node scripts/natlab/native.mjs --side A
 * The controller sends {"peer": {...}, "secret": hex} on stdin after both printed their
 * {"endpoint": {...}} line, and reads one {"result": {...}} line.
 */
import dgram from "node:dgram";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const side = process.argv[process.argv.indexOf("--side") + 1];
const stunServers = (process.argv[process.argv.indexOf("--stun") + 1] ?? "192.0.2.1:3478,192.0.2.2:3478").split(",").map((s) => {
  const [host, port] = s.split(":");
  return { host, port: Number(port) };
});

const vite = await createServer({ root: ROOT, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { punch } = await vite.ssrLoadModule("/src/native/punch.ts");
const { stunBindingRequest, parseStunResponse, classifyNat } = await vite.ssrLoadModule("/src/native/stun.ts");
const { DatagramLink } = await vite.ssrLoadModule("/src/native/datagramLink.ts");

/** A Node UDP socket as a PunchSocket (src/native/punch.ts). */
function openSocket() {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const handlers = new Set();
    s.on("message", (msg, rinfo) => {
      for (const h of handlers) h(new Uint8Array(msg), rinfo.port, rinfo.address);
    });
    s.bind(0, () => {
      resolve({
        localPort: s.address().port,
        send(bytes, port, host, ttl) {
          if (ttl) {
            s.setTTL(ttl);
            s.send(bytes, port, host, () => s.setTTL(64));
          } else s.send(bytes, port, host);
        },
        onMessage(h) {
          handlers.add(h);
          return () => handlers.delete(h);
        },
        close() {
          try {
            s.close();
          } catch {
            /* already closed */
          }
        },
      });
    });
  });
}

async function stun(sock, server) {
  const tid = crypto.getRandomValues(new Uint8Array(12));
  return new Promise((resolve) => {
    const off = sock.onMessage((b) => {
      const m = parseStunResponse(b, tid);
      if (!m) return;
      off();
      clearInterval(t);
      resolve(m);
    });
    const t = setInterval(() => sock.send(stunBindingRequest(tid), server.port, server.host), 200);
    sock.send(stunBindingRequest(tid), server.port, server.host);
    setTimeout(() => {
      off();
      clearInterval(t);
      resolve(null);
    }, 3000);
  });
}

const sock = await openSocket();
const first = await stun(sock, stunServers[0]);
const second = await stun(sock, stunServers[1]);
const nat = classifyNat(first, second);
process.stdout.write(JSON.stringify({ endpoint: { host: first?.address, port: first?.port, nat } }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
const job = await new Promise((resolve) => rl.once("line", (l) => resolve(JSON.parse(l))));
const secret = Uint8Array.from(Buffer.from(job.secret, "hex"));
const started = Date.now();
let result;
try {
  const p = await punch({ side, secret, me: nat, peer: job.peer, socket: sock, openSocket, timeoutMs: 30_000 });
  const link = new DatagramLink(
    {
      send: (b) => p.socket.send(b, p.remotePort, p.remoteHost),
      onMessage: (h) => p.socket.onMessage((b, port, host) => {
        if (host === p.remoteHost && port === p.remotePort) h(b);
      }),
      close: () => p.socket.close(),
    },
    secret,
    side,
  );
  const N = 100;
  const blob = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (side === "A" ? 1 : 2)) & 0xff);
  const texts = [];
  let binary = null;
  const got = new Promise((resolve) => {
    const check = () => texts.length === N && binary && resolve();
    link.onMessage((t) => {
      texts.push(t);
      check();
    });
    link.onBinary((b) => {
      binary = b;
      check();
    });
  });
  for (let i = 0; i < N; i++) link.send(`${side} message ${i}`);
  await link.sendBinary(blob);
  const other = side === "A" ? "B" : "A";
  await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("messages did not all arrive")), 60_000))]);
  const inOrder = texts.every((t, i) => t === `${other} message ${i}`);
  const expected = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (other === "A" ? 1 : 2)) & 0xff);
  const binOk = binary.length === expected.length && binary.every((x, i) => x === expected[i]);
  // Let the last acks out before closing.
  await new Promise((r) => setTimeout(r, 1500));
  link.close();
  result = { ok: inOrder && binOk, strategy: p.strategy, punchMs: p.ms, totalMs: Date.now() - started, nat, inOrder, binOk };
} catch (e) {
  result = { ok: false, error: e instanceof Error ? e.message : String(e), nat, totalMs: Date.now() - started };
}
process.stdout.write(JSON.stringify({ result }) + "\n");
await vite.close();
process.exit(0);
