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
import { JSDOM } from "jsdom";
import { pickDownloads, REPO } from "../../site/downloads.js";
import { EXTENSION_SRC, packExtension } from "../extension/pack.mjs";
import { CLOSED_KEYS, DEFAULT_LOCALE, LOCALES, localeOf } from "../../site/locales.js";

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
  // the moving facts strip under the hero (lower case, so the check below ignores case)
  ["<span>отворен код</span>", "<span>SHA-256 + SBOM</span>", "<span>open source</span>", "<span>SHA-256 + SBOM</span>"],
];

/** Any of these left on a closed-source page is a claim that is no longer true (case-insensitive). */
export const OPEN_CLAIM = /open[ -]source|отворен код|code is open|кодът е отворен|public code|публичния код/i;

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

/**
 * The public address of the site, ending in "/", or "" when it is not known (then no canonical link,
 * no sitemap and no share image: those need absolute addresses). SITE_URL, e.g. https://dyrakarmy.online/
 */
export function siteUrl(env = process.env) {
  const v = (env.SITE_URL ?? "").trim();
  if (!v) return "";
  let u;
  try { u = new URL(v); } catch { throw new Error(`SITE_URL must be an absolute https address, got "${v}"`); }
  if (u.protocol !== "https:" || u.search || u.hash) throw new Error(`SITE_URL must be an absolute https address, got "${v}"`);
  return u.href.endsWith("/") ? u.href : `${u.href}/`;
}

/** A relative href/src on the Bulgarian page ("site.css", "app/") seen from a language folder ("/en/"). */
const fromSub = (v) => (!v || /^(#|[a-z][a-z0-9+.-]*:|\/|\.\.\/)/i.test(v) ? v : `../${v}`);

/**
 * One language's page, rendered at build time from the Bulgarian one and that language's texts, so
 * it exists without JavaScript and search engines see it. `texts` holds every key of site/i18n.js EN.
 */
let enPopup;
/** The extension's own English strings (extension/_locales/en): other languages' pages show the popup as Chrome shows it there. */
function enPopupMessages() {
  enPopup ??= JSON.parse(readFileSync(join(EXTENSION_SRC, "_locales/en/messages.json"), "utf8"));
  return enPopup;
}

export function renderLocale(bgHtml, texts, loc) {
  const dom = new JSDOM(bgHtml);
  const d = dom.window.document;
  const html = d.documentElement;
  html.lang = loc.html;
  html.setAttribute("data-root", "../");
  d.title = texts.title;
  const meta = (sel, value) => { const m = d.querySelector(sel); if (m && value) m.setAttribute("content", value); };
  meta('meta[name="description"]', texts.metaDescription);
  meta('meta[property="og:title"]', texts.ogTitle);
  meta('meta[property="og:description"]', texts.ogDescription);
  meta('meta[property="og:locale"]', loc.og);
  const missing = [];
  const get = (key) => { const v = texts[key]; if (v == null || v === "") missing.push(key); return v; };
  for (const el of d.querySelectorAll("[data-i18n]")) { const v = get(el.getAttribute("data-i18n")); if (v) el.textContent = v; }
  for (const el of d.querySelectorAll("[data-i18n-html]")) { const v = get(el.getAttribute("data-i18n-html")); if (v) el.innerHTML = v; }
  for (const el of d.querySelectorAll("[data-i18n-aria]")) { const v = get(el.getAttribute("data-i18n-aria")); if (v) el.setAttribute("aria-label", v); }
  // the mock of the extension popup: the extension has Bulgarian and English only, so every other page shows the English one
  if (loc.code !== "bg") {
    for (const el of d.querySelectorAll("[data-ext-msg]")) {
      const m = enPopupMessages()[el.getAttribute("data-ext-msg")];
      if (!m) throw new Error(`site: extension/_locales/en has no message ${el.getAttribute("data-ext-msg")}`);
      el.textContent = m.message;
    }
    for (const el of d.querySelectorAll("[data-ext-mock]")) el.setAttribute("lang", "en");
  }
  // a gap would show Bulgarian on a foreign page: stop the build instead (the tests check the packs too)
  if (missing.length) throw new Error(`site: ${loc.code} has no text for ${[...new Set(missing)].join(", ")}`);
  for (const el of d.querySelectorAll("[href], [src]")) {
    for (const a of ["href", "src"]) if (el.hasAttribute(a)) el.setAttribute(a, fromSub(el.getAttribute(a)));
  }
  // the public documents have an English original; the Bulgarian page links the translations
  for (const a of d.querySelectorAll('a[href*="/blob/main/"]')) {
    a.setAttribute("href", a.getAttribute("href").replace(/SECURITY\.bg\.md$/, "SECURITY.md").replace(/LICENSE\.bg\.md$/, "LICENSE"));
  }
  return dom.serialize();
}

/** The English page (kept for callers of the two-language build). */
export const renderEnglish = (bgHtml, EN) => renderLocale(bgHtml, EN, localeOf("en"));

/**
 * The language menu of one page, from site/locales.js: every language, the current one marked, links
 * relative to the page ("../es/" from "/en/"). Also tells boot.js which page this is and which exist.
 */
export function withLangMenu(html, code) {
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const here = localeOf(code);
  const up = here.path ? "../" : "";
  d.documentElement.setAttribute("data-lang", code);
  d.documentElement.setAttribute("data-langs", LOCALES.map((l) => l.code).join(" "));
  d.documentElement.removeAttribute("data-other");
  const list = d.querySelector("[data-lang-list]");
  if (!list) throw new Error("site: the language menu ([data-lang-list]) is missing from site/index.html");
  list.textContent = "";
  for (const l of LOCALES) {
    const li = d.createElement("li");
    const a = d.createElement("a");
    a.setAttribute("href", l.code === code ? "./" : up + l.path || "./");
    a.setAttribute("hreflang", l.html);
    a.setAttribute("lang", l.html);
    a.setAttribute("data-code", l.code);
    if (l.code === code) a.setAttribute("aria-current", "page");
    a.textContent = l.name;
    li.append(a);
    list.append(d.createTextNode("\n            "), li);
  }
  list.append(d.createTextNode("\n          "));
  const current = d.querySelector("[data-lang-current]");
  if (current) current.textContent = here.short;
  return dom.serialize();
}

/**
 * Canonical address, the two language versions, the share image and structured data (the app and
 * its questions and answers, read from the page itself so they always match what is shown).
 * Without SITE_URL only the structured data is added.
 */
export function addSeo(html, { lang, url }) {
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const head = d.head;
  const add = (tag, attrs) => { const el = d.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); head.appendChild(el); return el; };
  const page = localeOf(lang);
  if (url) {
    add("link", { rel: "canonical", href: url + page.path });
    for (const l of LOCALES) add("link", { rel: "alternate", hreflang: l.html, href: url + l.path });
    add("link", { rel: "alternate", hreflang: "x-default", href: url + localeOf(DEFAULT_LOCALE).path });
    add("meta", { property: "og:url", content: url + page.path });
    add("meta", { property: "og:image", content: url + page.image });
    add("meta", { property: "og:image:width", content: "1200" });
    add("meta", { property: "og:image:height", content: "630" });
    add("meta", { property: "og:image:alt", content: d.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "P2P Messenger" });
    for (const l of LOCALES) if (l.code !== lang) add("meta", { property: "og:locale:alternate", content: l.og });
  }
  const faq = [...d.querySelectorAll("details")].map((x) => [x.querySelector("summary")?.textContent?.trim(), x.querySelector("p")?.textContent?.trim()]).filter(([q, a]) => q && a);
  const data = [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "P2P Messenger",
      applicationCategory: "CommunicationApplication",
      operatingSystem: "Windows, Linux, Android, iOS, Web",
      description: d.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      inLanguage: page.html,
      offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
      ...(url ? { url: url + page.path, image: url + page.image } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: page.html,
      mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
    },
  ];
  const ld = d.createElement("script");
  ld.setAttribute("type", "application/ld+json");
  // data, never code: "<" escaped so the text cannot close the tag
  ld.textContent = JSON.stringify(data).replaceAll("<", "\\u003c");
  head.appendChild(ld);
  return dom.serialize().replace(/\s*<!--seo:[^>]*-->/, "");
}

export function robotsTxt(url) {
  return `User-agent: *\nAllow: /\n${url ? `\nSitemap: ${url}sitemap.xml\n` : ""}`;
}

export function sitemapXml(url, lastmod) {
  const alts = LOCALES.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.html}" href="${url}${l.path}"/>`).join("\n");
  const entries = LOCALES.map((p) => `  <url>\n    <loc>${url}${p.path}</loc>\n    <lastmod>${lastmod}</lastmod>\n${alts}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${url}"/>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries}\n</urlset>\n`;
}

/** The stable address of the Chrome extension package, relative to the site root. */
export const EXTENSION_ZIP = "downloads/p2p-messenger-quick-launch.zip";

/**
 * Packs the extension from the same checkout as the site and publishes it under downloads/:
 * a stable name (the button), the versioned name, and extension.json with what the page shows.
 * The bytes are the same on every build of the same files (scripts/extension/pack.mjs).
 */
export function publishExtension(dist, src = EXTENSION_SRC) {
  const pkg = packExtension({ src });
  const dir = join(dist, "downloads");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "p2p-messenger-quick-launch.zip"), pkg.zip);
  writeFileSync(join(dir, pkg.file), pkg.zip);
  const info = { version: pkg.version, size: pkg.size, sha256: pkg.sha256, file: pkg.file };
  writeFileSync(join(dir, "extension.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

/** Fills the (empty) extension block of the page. Same escaping as the releases block. */
export function injectExtension(html, info) {
  const json = JSON.stringify(info).replaceAll("<", "\\u003c");
  const marker = /(<script type="application\/json" id="extension-info">)[\s\S]*?(<\/script>)/;
  if (!marker.test(html)) throw new Error("extension block not found in site/index.html");
  return html.replace(marker, (_m, a, b) => `${a}${json}${b}`);
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

/**
 * One language's texts (site/i18n/<code>.js). Its `closed` part holds the wording for a private
 * source (CLOSED_KEYS) and replaces those keys in closed mode; it is never shipped as page text.
 */
export async function loadPack(file, { closed }) {
  const { default: pack } = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  const { closed: closedText = {}, ...texts } = pack;
  if (!closed) return texts;
  for (const k of CLOSED_KEYS) {
    if (!closedText[k]) throw new Error(`site: ${file} has no closed-source text for ${k}`);
    texts[k] = closedText[k];
  }
  return texts;
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

export async function assemble({ dist = join(ROOT, "dist"), site = join(ROOT, "site"), extensionSrc = EXTENSION_SRC, releases, closed = isClosed(), repo = releasesRepo(), url = siteUrl(), now = new Date() } = {}) {
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
  const toRepo = (t) => t.replaceAll(`github.com/${REPO}/releases`, `github.com/${repo}/releases`).replaceAll("{{PUBLIC_REPO}}", repo);
  const extension = publishExtension(dist, extensionSrc);
  const html = injectExtension(injectReleases(applyMode(toRepo(readFileSync(join(dist, "index.html"), "utf8")), { closed, lang: "bg" }), pickDownloads(releases ?? [])), extension);
  const dl = join(dist, "downloads.js");
  writeFileSync(dl, readFileSync(dl, "utf8").replace(`REPO = "${REPO}"`, `REPO = "${repo}"`));
  const i18n = join(dist, "i18n.js");
  writeFileSync(i18n, applyMode(readFileSync(i18n, "utf8"), { closed, lang: "en" }));
  // the English texts as they will be served (closed wording already applied)
  const { EN } = await import(`data:text/javascript;base64,${Buffer.from(readFileSync(i18n, "utf8")).toString("base64")}`);
  const pages = {};
  for (const loc of LOCALES) {
    const texts = loc.code === "bg" ? null : loc.code === "en" ? EN : await loadPack(join(site, "i18n", `${loc.code}.js`), { closed });
    const page = texts ? renderLocale(html, texts, loc) : html;
    pages[loc.code] = addSeo(withLangMenu(page, loc.code), { lang: loc.code, url });
    mkdirSync(join(dist, loc.path), { recursive: true });
    writeFileSync(join(dist, loc.path, "index.html"), pages[loc.code]);
  }
  // the packs the browser loads: this mode's wording only, without the other variant
  const shipped = [];
  for (const loc of LOCALES) {
    if (loc.code === "bg" || loc.code === "en") continue;
    const texts = await loadPack(join(site, "i18n", `${loc.code}.js`), { closed });
    const text = `/* ${loc.name}: built from site/i18n/${loc.code}.js */\nexport default ${JSON.stringify(texts).replaceAll("<", "\\u003c")};\n`;
    writeFileSync(join(dist, "i18n", `${loc.code}.js`), text);
    shipped.push(text);
  }
  writeFileSync(join(dist, "robots.txt"), robotsTxt(url));
  if (url) writeFileSync(join(dist, "sitemap.xml"), sitemapXml(url, now.toISOString().slice(0, 10)));
  // no mixed state: a replaced wording must have found its place
  if (closed && OPEN_CLAIM.test(readFileSync(i18n, "utf8") + Object.values(pages).join("") + shipped.join(""))) {
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
