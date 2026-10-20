/**
 * Local simulation of everything the app talks to, with no network and no secrets.
 *
 *  - App server:    serves dist/ (SPA fallback, correct content types, .well-known as JSON).
 *  - Worker server: runs the REAL Worker code (worker/index.ts, bundled on start) over HTTP,
 *                   with an in-memory KV that honours expirationTtl and a controllable clock.
 *  - Mock Telegram: every call the Worker makes to api.telegram.org is answered in-process
 *                   and recorded, so message sending and deletion can be asserted.
 *
 * Control endpoints on the Worker port (mock only, never part of the real Worker):
 *   GET  /__mock/state           messages, callback answers, KV keys, clock offset
 *   POST /__mock/clock           {"advanceMs": 660000} moves time forward
 *   POST /__mock/cron            runs the scheduled handler (purges due deliveries)
 *   POST /__mock/reset           clears KV, messages and the clock
 *   POST /__mock/telegram/block  {"chatId": 333} makes sendMessage to that chat fail
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const MOCK_BOT_TOKEN = "mock:token";
export const MOCK_WEBHOOK_SECRET = "mock-webhook-secret";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** In-memory stand-in for a Workers KV namespace, with TTL and a shared clock. */
class MockKV {
  constructor(now) {
    this.now = now;
    this.data = new Map();
  }
  live(key) {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return e;
  }
  async get(key, type) {
    const e = this.live(key);
    if (!e) return null;
    return type === "json" ? JSON.parse(e.value) : e.value;
  }
  async put(key, value, opts = {}) {
    const ttl = opts.expirationTtl;
    if (ttl !== undefined && ttl < 60) throw new Error("KV expirationTtl must be at least 60 seconds");
    this.data.set(key, { value, expiresAt: ttl ? this.now() + ttl * 1000 : Infinity });
  }
  async delete(key) {
    this.data.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && this.live(k)).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
  keys() {
    return [...this.data.keys()].filter((k) => this.live(k));
  }
  clear() {
    this.data.clear();
  }
}

async function loadWorker() {
  const outDir = path.join(ROOT, "node_modules", ".cache", "mock-worker");
  await build({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    ssr: { noExternal: true },
    build: {
      ssr: path.join(ROOT, "worker", "index.ts"),
      outDir,
      emptyOutDir: true,
      minify: false,
      target: "node20",
      rollupOptions: { output: { format: "es", entryFileNames: "worker.mjs" } },
    },
  });
  return import(pathToFileURL(path.join(outDir, "worker.mjs")).href + `?t=${Date.now()}`);
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

/**
 * @param {{appPort?: number|null, workerPort?: number, host?: string, distDir?: string}} opts
 * Use port 0 for a random free port. appPort null skips the app server.
 */
export async function startMock(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const distDir = opts.distDir ?? path.join(ROOT, "dist");
  const worker = await loadWorker();

  // Controllable clock: Date.now() = real time + offset. Restored on close.
  const realNow = Date.now.bind(Date);
  let offset = 0;
  Date.now = () => realNow() + offset;
  const kv = new MockKV(() => Date.now());

  // Mock Telegram, answering what the Worker's fetch() asks of api.telegram.org.
  const tg = { messages: [], answers: [], blocked: new Set(), nextId: 1000 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!m) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    const fail = (status, description) => new Response(JSON.stringify({ ok: false, description }), { status });
    if (m[1] !== MOCK_BOT_TOKEN) return fail(401, "Unauthorized");
    switch (m[2]) {
      case "sendMessage": {
        if (tg.blocked.has(body.chat_id)) return fail(403, "Forbidden: bot can't initiate conversation");
        const msg = {
          id: tg.nextId++,
          chatId: body.chat_id,
          text: body.text,
          replyMarkup: body.reply_markup ?? null,
          deleted: false,
        };
        tg.messages.push(msg);
        return ok({ message_id: msg.id });
      }
      case "deleteMessage": {
        const msg = tg.messages.find((x) => x.chatId === body.chat_id && x.id === body.message_id && !x.deleted);
        if (!msg) return fail(400, "Bad Request: message to delete not found");
        msg.deleted = true;
        return ok(true);
      }
      case "answerCallbackQuery":
        tg.answers.push({ id: body.callback_query_id, text: body.text });
        return ok(true);
      default:
        return fail(404, "Not Found");
    }
  };

  const env = {
    TELEGRAM_BOT_TOKEN: MOCK_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: MOCK_WEBHOOK_SECRET,
    DELIVERIES: kv,
  };

  const workerServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith("/__mock/")) {
        const raw = req.method === "POST" ? (await readBody(req)).toString("utf8") : "";
        const body = raw ? JSON.parse(raw) : {};
        switch (`${req.method} ${url.pathname}`) {
          case "GET /__mock/state":
            return json(res, 200, { messages: tg.messages, answers: tg.answers, kvKeys: kv.keys(), clockOffsetMs: offset });
          case "POST /__mock/clock":
            offset += Number(body.advanceMs) || 0;
            return json(res, 200, { clockOffsetMs: offset });
          case "POST /__mock/cron":
            await worker.default.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env);
            return json(res, 200, { ok: true });
          case "POST /__mock/reset":
            kv.clear();
            tg.messages.length = 0;
            tg.answers.length = 0;
            tg.blocked.clear();
            offset = 0;
            return json(res, 200, { ok: true });
          case "POST /__mock/telegram/block":
            tg.blocked.add(Number(body.chatId));
            return json(res, 200, { ok: true });
          default:
            return json(res, 404, { error: "unknown mock endpoint" });
        }
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const response = await worker.default.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });
  const workerPort = await listen(workerServer, opts.workerPort ?? 8787, host);

  let appServer = null;
  let appPort = null;
  if (opts.appPort !== null) {
    appServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      let rel = decodeURIComponent(url.pathname);
      let file = path.join(distDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(distDir)) return json(res, 403, { error: "forbidden" });
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // Real files and well-known paths 404; app routes fall back to index.html.
        if (path.extname(rel) || rel.startsWith("/.well-known/")) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("Not found");
        }
        file = path.join(distDir, "index.html");
      }
      const type =
        path.basename(file) === "apple-app-site-association"
          ? "application/json"
          : MIME[path.extname(file)] ?? "application/octet-stream";
      const noCache = /(^|[/\\])(sw\.js|index\.html|manifest\.webmanifest)$/.test(file);
      res.writeHead(200, { "content-type": type, "cache-control": noCache ? "no-cache" : "public, max-age=3600" });
      fs.createReadStream(file).pipe(res);
    });
    appPort = await listen(appServer, opts.appPort ?? 4173, host);
  }

  const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
  return {
    appUrl: appPort ? `http://${shown}:${appPort}` : null,
    workerUrl: `http://${shown}:${workerPort}`,
    appPort,
    workerPort,
    kv,
    tg,
    async close() {
      await new Promise((r) => workerServer.close(r));
      if (appServer) await new Promise((r) => appServer.close(r));
      Date.now = realNow;
      globalThis.fetch = realFetch;
    },
  };
}
