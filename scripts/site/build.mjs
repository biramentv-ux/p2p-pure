#!/usr/bin/env node
/**
 * Builds the public site: the landing page at "/" and the messenger at "/app/".
 *
 *   node scripts/site/build.mjs --build [--base /p2p-pure/]   build the app for <base>app/, then assemble
 *   node scripts/site/build.mjs                               assemble from an existing dist/ (built for <base>app/)
 *   --releases-file <json>                                    use this releases list instead of asking GitHub
 *   --closed                                                  the source code is private (also: SOURCE_CLOSED=1)
 *
 * Private source (docs/PRIVATE-REPO.md): RELEASES_REPO="owner/public-repo" makes the download buttons
 * and the releases list come from that repository. --closed also removes the claims that only hold
 * for public code ("open source", links to files that live in the private repository).
 *
 * The desktop (Tauri/Electron) and mobile (Capacitor) builds do not use this: they package the
 * app itself, from a plain `vite build`.
 *
 * Releases: the newest published files are looked up once, here, through the GitHub API (token
 * from GITHUB_TOKEN/GH_TOKEN when there is one) and written into the page, so a visitor's browser
 * never calls GitHub just to render the download buttons. Without network the buttons point to the
 * releases page.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickDownloads, REPO } from "../../site/downloads.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The files the stylesheet names, from the @fontsource packages the app already ships. */
export const FONT_FILES = [
  ["ibm-plex-serif", "ibm-plex-serif-cyrillic-500-normal.woff2"],
  ["ibm-plex-serif", "ibm-plex-serif-latin-500-normal.woff2"],
  ["ibm-plex-serif", "ibm-plex-serif-cyrillic-500-italic.woff2"],
  ["ibm-plex-serif", "ibm-plex-serif-latin-500-italic.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-cyrillic-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-cyrillic-600-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-cyrillic-400-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
];

/**
 * Replaces the empty releases block. The JSON sits in a <script type="application/json">, so "<"
 * is escaped and the data can never close the tag or run as code.
 */
/** Where the releases live: RELEASES_REPO, else the repository named in site/downloads.js. */
export function releasesRepo(env = process.env) {
  const v = (env.RELEASES_REPO ?? "").trim();
  if (!v) return REPO;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) throw new Error(`RELEASES_REPO must look like owner/repo, got "${v}"`);
  return v;
}

export function isClosed(env = process.env, args = process.argv.slice(2)) {
  return args.includes("--closed") || /^(1|true|yes)$/i.test((env.SOURCE_CLOSED ?? "").trim());
}

/** Wording that is only true while the code is public. [Bulgarian (page), English (i18n.js)] per entry. */
export const CLOSED_TEXT = [
  ["Отворен код · Windows, Linux, Android, iPhone и браузър", "Без акаунт · Windows, Linux, Android, iPhone и браузър",
    "Open source · Windows, Linux, Android, iPhone and browser", "No account · Windows, Linux, Android, iPhone and browser"],
  [">Отворен код</b>", ">Подписани издания</b>", 'sec1t: "Open source"', 'sec1t: "Signed releases"'],
  ["Всеки ред е в GitHub. Всяко издание има", "Всяко издание има", "Every line is on GitHub. Each release has", "Each release has"],
  [" Кодът е отворен.</p>", "</p>", " The code is open.", ""],
  ["от публичния код.", "от изходния код.", "from the public code.", "from the source code."],
];

/**
 * Keeps one side of <!--when:open-->…<!--/when--> and <!--when:closed-->…<!--/when--> blocks, so a page
 * can carry both variants. With closed: the wording above is swapped too (en = i18n.js text).
 */
export function applyMode(text, { closed, lang }) {
  const keep = closed ? "closed" : "open", drop = closed ? "open" : "closed";
  let out = text
    .replace(new RegExp(`<!--when:${drop}-->[\\s\\S]*?<!--/when-->\\n?`, "g"), "")
    .replace(new RegExp(`<!--when:${keep}-->\\n?|<!--/when-->\\n?`, "g"), "");
  if (closed) {
    for (const row of CLOSED_TEXT) {
      const [from, to] = lang === "en" ? [row[2], row[3]] : [row[0], row[1]];
      if (!out.includes(from)) continue;
      out = out.replaceAll(from, to);
    }
  }
  return out;
}

export function injectReleases(html, picked) {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const json = JSON.stringify(picked).replaceAll("<", "\\u003c").replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
  const marker = /(<script type="application\/json" id="releases">)[\s\S]*?(<\/script>)/;
  if (!marker.test(html)) throw new Error("releases block not found in site/index.html");
  return html.replace(marker, (_m, a, b) => `${a}${json}${b}`);
}

/**
 * Served at /sw.js. Before the site moved, the messenger was the page at "/" and installed a service
 * worker there that would keep serving the old app from its cache. Browsers re-check that exact file,
 * so this replacement removes the old worker and its caches and then reloads open tabs into the new
 * layout. The messenger's own worker lives at /app/sw.js with its own scope and is not touched.
 */
export function killSwitchWorker() {
  return `/* Retires the service worker the messenger used to register at the site root. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const root = self.registration.scope; // e.g. https://host/
      for (const name of await caches.keys()) {
        // workbox names its caches after the scope: only the root scope is the old app
        if (name.endsWith(root) || name === root) await caches.delete(name);
      }
    } catch (e) { /* nothing to clear */ }
    await self.registration.unregister();
    const tabs = await self.clients.matchAll({ type: "window" });
    for (const tab of tabs) tab.navigate(tab.url);
  })());
});
`;
}

async function fetchReleases() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "p2p-pure-site-build", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${releasesRepo()}/releases?per_page=50`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub API answered ${res.status}`);
  return res.json();
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}

export async function assemble({ dist = join(ROOT, "dist"), site = join(ROOT, "site"), releases, closed = isClosed(), repo = releasesRepo() } = {}) {
  if (!existsSync(join(dist, "index.html"))) throw new Error(`${dist}/index.html is missing: build the app first`);
  const appTmp = `${dist}-app`;
  rmSync(appTmp, { recursive: true, force: true });
  renameSync(dist, appTmp);
  mkdirSync(dist, { recursive: true });

  cpSync(site, dist, { recursive: true });
  // fonts, from the packages (no download, no external request)
  const fonts = join(dist, "fonts");
  mkdirSync(fonts, { recursive: true });
  for (const [pkg, file] of FONT_FILES) {
    const src = join(ROOT, "node_modules/@fontsource", pkg, "files", file);
    if (!existsSync(src)) throw new Error(`font file missing: ${src} (run npm ci)`);
    cpSync(src, join(fonts, file));
  }

  // the messenger under /app/; what must live at the domain root moves out of it
  const app = join(dist, "app");
  renameSync(appTmp, app);
  const wk = join(app, ".well-known");
  if (existsSync(wk)) { cpSync(wk, join(dist, ".well-known"), { recursive: true }); rmSync(wk, { recursive: true, force: true }); }
  for (const f of ["icons", "favicon.svg"]) {
    if (existsSync(join(app, f))) cpSync(join(app, f), join(dist, f), { recursive: true });
  }
  writeFileSync(join(dist, "sw.js"), killSwitchWorker());
  // GitHub Pages: no Jekyll processing, so ".well-known" and underscored names are served as they are
  writeFileSync(join(dist, ".nojekyll"), "");

  // releases (and, when the source is private, the wording) of the public page
  const toRepo = (t) => t.replaceAll(`github.com/${REPO}/releases`, `github.com/${repo}/releases`);
  const html = applyMode(toRepo(readFileSync(join(dist, "index.html"), "utf8")), { closed, lang: "bg" });
  writeFileSync(join(dist, "index.html"), injectReleases(html, pickDownloads(releases ?? [])));
  const dl = join(dist, "downloads.js");
  writeFileSync(dl, readFileSync(dl, "utf8").replace(`REPO = "${REPO}"`, `REPO = "${repo}"`));
  const i18n = join(dist, "i18n.js");
  writeFileSync(i18n, applyMode(readFileSync(i18n, "utf8"), { closed, lang: "en" }));
  // no mixed state: a replaced wording must have found its place
  if (closed && /Open source|Отворен код/.test(readFileSync(i18n, "utf8") + readFileSync(join(dist, "index.html"), "utf8"))) {
    throw new Error("closed mode: some open-source wording is still on the page (update CLOSED_TEXT in scripts/site/build.mjs)");
  }
  return { files: readdirSync(dist) };
}

async function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : process.env.PAGES_BASE || "/";
  if (!/^\/(.*\/)?$/.test(base)) throw new Error(`--base must start and end with "/": ${base}`);
  if (args.includes("--build")) run("npm", ["run", "build"], { BASE_PATH: `${base}app/` });

  let releases = [];
  const fileIdx = args.indexOf("--releases-file");
  try {
    // --releases-file: the output of `gh api repos/<repo>/releases`, for a build without network access
    releases = fileIdx >= 0 ? JSON.parse(readFileSync(args[fileIdx + 1], "utf8")) : await fetchReleases();
  } catch (e) {
    console.warn(`::warning title=site-releases::could not read the releases (${e.message}); the download buttons point to the releases page`);
  }
  const out = await assemble({ releases });
  console.log(`site assembled: ${out.files.join(", ")}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
