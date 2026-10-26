/**
 * Which file of the bundled web app a request may read. The app is served from its own
 * origin (app://p2p) out of one folder; nothing outside that folder is ever reachable,
 * whatever the address looks like (.., encoded dots, backslashes, NUL bytes, other hosts).
 */
import { resolve, sep, extname, posix } from "node:path";

export const APP_HOST = "p2p";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** The type to send for a file. Unknown extensions are plain bytes, never guessed as HTML. */
export function mimeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Maps an app:// address to a file inside `root`, or null when it must be refused.
 * "/" and folder-like paths give index.html (the app has a single page).
 */
export function resolveAppFile(root, requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "app:" || url.host !== APP_HOST) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname || "/");
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  const clean = posix.normalize(path);
  if (clean.split("/").includes("..")) return null;
  const rel = clean === "/" || clean.endsWith("/") ? clean + "index.html" : clean;
  const base = resolve(root);
  const file = resolve(base, "." + rel);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return file;
}
