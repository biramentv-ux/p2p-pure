/**
 * Starts the full local simulation and keeps it running.
 *
 *   npm run mock:server
 *
 * App:    http://127.0.0.1:4173   (serves dist/, run `npm run build` first)
 * Worker: http://127.0.0.1:8787   (real Worker code, in-memory KV, mock Telegram)
 *
 * Environment: APP_PORT, WORKER_PORT, HOST (default 0.0.0.0 so other devices on the
 * same network can reach it; use HOST=127.0.0.1 to keep it local).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, MOCK_WEBHOOK_SECRET } from "./mockServer.mjs";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/index.html");
if (!fs.existsSync(dist)) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

const mock = await startMock({
  host: process.env.HOST ?? "0.0.0.0",
  appPort: Number(process.env.APP_PORT ?? 4173),
  workerPort: Number(process.env.WORKER_PORT ?? 8787),
});

console.log(`App:     ${mock.appUrl}`);
console.log(`Worker:  ${mock.workerUrl}   (webhook secret for mock: ${MOCK_WEBHOOK_SECRET})`);
console.log(`State:   ${mock.workerUrl}/__mock/state`);
console.log("Ctrl+C to stop.");

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
