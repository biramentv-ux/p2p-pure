// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ES modules, shared with the browser
import { detectOS, formatSize, pickDownloads, versionOf } from "../../site/downloads.js";
// @ts-expect-error plain ES module script
import { FONT_FILES, OPEN_CLAIM, applyMode, assemble, injectReleases, killSwitchWorker, releasesRepo, siteUrl } from "../../scripts/site/build.mjs";
// @ts-expect-error plain ES module
import { BG_EXTRA, EN } from "../../site/i18n.js";
// @ts-expect-error plain ES module
import { CLOSED_KEYS, LOCALES } from "../../site/locales.js";

type Locale = { code: string; path: string; html: string; og: string; name: string; short: string; image: string; scripts: string[] };
type Pack = Record<string, unknown> & { closed: Record<string, string>; demoMsgs: string[]; osNames: Record<string, string> };
const FOREIGN = (LOCALES as Locale[]).filter((l) => l.code !== "bg" && l.code !== "en");
const packs: Record<string, Pack> = {};
for (const l of FOREIGN) packs[l.code] = (await import(`../../site/i18n/${l.code}.js`)).default;

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

type Asset = { name: string; size: number; browser_download_url: string };
const rel = (tag: string, published: string, names: string[], extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: published,
  assets: names.map((name): Asset => ({ name, size: 2048, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` })),
  ...extra,
});

describe("pickDownloads", () => {
  it("offers a stable release's files, and falls back to a test build only where no stable file exists", () => {
    const picked = pickDownloads([
      rel("android-v0.0.0-preview.5", "2026-10-26T18:51:55Z", ["P2P-Messenger-0.7.0-android.apk", "SHA256SUMS-android.txt"]),
      rel("desktop-v0.7.0", "2026-10-26T03:12:26Z", ["P2P-Messenger-Setup-x64.exe", "P2P-Messenger-portable-x64.zip", "SHA256SUMS.txt"]),
    ]);
    expect(picked.windowsSetup).toMatchObject({ version: "0.7.0", preview: false, tag: "desktop-v0.7.0" });
    expect(picked.apk).toMatchObject({ version: "0.7.0", preview: true, tag: "android-v0.0.0-preview.5" });
    expect(picked.deb).toBeUndefined();
  });

  it("prefers a newer stable release and never offers a draft", () => {
    const picked = pickDownloads([
      rel("android-v1.0.0", "2026-11-01T00:00:00Z", ["P2P-Messenger-1.0.0-android.apk"], { draft: true }),
      rel("android-v0.9.0", "2026-10-30T00:00:00Z", ["P2P-Messenger-0.9.0-android.apk"]),
      rel("android-v0.0.0-preview.9", "2026-11-02T00:00:00Z", ["P2P-Messenger-0.9.5-android.apk"]),
    ]);
    expect(picked.apk).toMatchObject({ version: "0.9.0", preview: false });
  });

  it("matches Linux packages by their names and ignores unrelated tags and files", () => {
    const picked = pickDownloads([
      rel("desktop-v0.8.0", "2026-11-05T00:00:00Z", [
        "P2P-Messenger-0.8.0-amd64.deb", "P2P-Messenger-0.8.0-x86_64.rpm", "P2P-Messenger-0.8.0-x86_64.AppImage",
        "P2P-Messenger-0.8.0.flatpak", "install.sh", "SHA256SUMS-linux.txt", "notes.txt",
      ]),
      rel("v9.9.9", "2026-12-01T00:00:00Z", ["P2P-Messenger-Setup-x64.exe"]),
    ]);
    expect(Object.keys(picked).sort()).toEqual(["appimage", "deb", "flatpak", "linuxInstall", "linuxSums", "rpm"]);
    expect(picked.windowsSetup).toBeUndefined();
  });

  it("copes with an empty or broken list", () => {
    expect(pickDownloads([])).toEqual({});
    expect(pickDownloads(undefined as never)).toEqual({});
    expect(pickDownloads([null, { tag_name: "desktop-v1.0.0" }] as never)).toEqual({});
  });

  it("reads the version from the file name first (test tags say 0.0.0)", () => {
    expect(versionOf("android-v0.0.0-preview.2", "P2P-Messenger-0.7.0-android.apk")).toBe("0.7.0");
    expect(versionOf("desktop-v0.7.0", "SHA256SUMS.txt")).toBe("0.7.0");
  });
});

describe("formatSize and detectOS", () => {
  it("formats sizes in MB and KB", () => {
    expect(formatSize(3312216)).toBe("3.2 MB");
    expect(formatSize(193)).toBe("1 KB");
    expect(formatSize(0)).toBe("");
    expect(formatSize(NaN)).toBe("");
  });
  it("recognises the visitor's system", () => {
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32", 0)).toBe("windows");
    expect(detectOS("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64", 0)).toBe("linux");
    expect(detectOS("Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv81", 5)).toBe("android");
    expect(detectOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5)).toBe("ios");
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0)).toBe("mac");
    expect(detectOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5)).toBe("ios"); // iPadOS
    expect(detectOS("", "", 0)).toBe("other");
  });
});

describe("site assembly", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function fakeDist() {
    const d = mkdtempSync(join(tmpdir(), "site-"));
    dirs.push(d);
    const dist = join(d, "dist");
    mkdirSync(join(dist, ".well-known"), { recursive: true });
    mkdirSync(join(dist, "icons"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(join(dist, "sw.js"), "// the messenger's own worker");
    writeFileSync(join(dist, "favicon.svg"), "<svg/>");
    writeFileSync(join(dist, "icons/icon-192.png"), "png");
    writeFileSync(join(dist, ".well-known/assetlinks.json"), "[]");
    return dist;
  }

  it("puts the site at / and the messenger at /app/, keeping what must stay at the domain root", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [rel("desktop-v0.7.0", "2026-10-26T03:12:26Z", ["P2P-Messenger-Setup-x64.exe"])] });
    expect(readFileSync(join(dist, "app/index.html"), "utf8")).toContain("<title>app</title>");
    expect(readFileSync(join(dist, "app/sw.js"), "utf8")).toContain("the messenger's own worker");
    expect(existsSync(join(dist, "app/.well-known"))).toBe(false);
    expect(readFileSync(join(dist, ".well-known/assetlinks.json"), "utf8")).toBe("[]");
    expect(existsSync(join(dist, "icons/icon-192.png"))).toBe(true);
    expect(existsSync(join(dist, ".nojekyll"))).toBe(true);
    for (const [, file] of FONT_FILES) expect(existsSync(join(dist, "fonts", file as string)), file as string).toBe(true);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain("Писмата ти");
    expect(html).toMatch(/id="releases">\{"windowsSetup":\{"name":"P2P-Messenger-Setup-x64\.exe"/);
    expect(existsSync(`${dist}-app`)).toBe(false);
  });

  it("with a separate public releases repository, the page and the buttons point there", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: false });
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain("https://github.com/o/pub/releases");
    expect(html).not.toContain("github.com/biramentv-ux/p2p-pure/releases");
    expect(html).toContain("blob/main/SECURITY.md"); // open source: the footer still links to the code
    expect(readFileSync(join(dist, "downloads.js"), "utf8")).toContain('REPO = "o/pub"');
  });

  it("with private source, no page claims open code or links to files that only the private repository has", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true });
    const html = readFileSync(join(dist, "index.html"), "utf8");
    const en = readFileSync(join(dist, "i18n.js"), "utf8");
    for (const text of [html, en]) {
      expect(text).not.toMatch(OPEN_CLAIM);
      expect(text).not.toMatch(/open source|отворен код/i); // the facts strip is lower case
      expect(text).not.toContain("<!--when:");
    }
    expect(html).not.toContain("github.com/biramentv-ux/p2p-pure/"); // the private repository
    expect(html).not.toContain("github.com/biramentv-ux/p2p-pure\""); // its front page
    for (const [, href] of html.matchAll(/href="(https:\/\/github\.com\/[^"]*\/blob\/[^"]*)"/g)) expect(href).toMatch(/^https:\/\/github\.com\/o\/pub\/blob\/main\/(SECURITY|LICENSE)/);
    expect(html).toContain("https://github.com/o/pub/releases");
    expect(html).toContain("Подписани издания");
    expect(en).toContain("Signed releases");
  });

  it("builds the English page as its own address, readable without JavaScript", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true, url: "" });
    const en = readFileSync(join(dist, "en/index.html"), "utf8");
    expect(en).toMatch(/<html lang="en"/);
    expect(en).toContain("<title>Messenger without a phone number or server · P2P Messenger</title>");
    expect(en).toContain("Your letters.");
    expect(en).not.toContain("Писмата ти");
    expect(en).toMatch(/<a href="\.\.\/" hreflang="bg" lang="bg" data-code="bg">Български<\/a>/);
    expect(en).toMatch(/<a href="\.\/" hreflang="en" lang="en" data-code="en" aria-current="page">English<\/a>/);
    expect(en).toMatch(/<a href="\.\.\/zh\/" hreflang="zh-Hans"/);
    expect(en).toContain('href="../site.css"');
    expect(en).toContain('href="../app/"');
    expect(en).toContain('href="#features"'); // in-page links stay on this page
    expect(en).toContain("https://github.com/o/pub/blob/main/SECURITY.md");
    expect(en).toContain("https://github.com/o/pub/blob/main/LICENSE\"");
    expect(en).not.toMatch(OPEN_CLAIM);
    const bg = readFileSync(join(dist, "index.html"), "utf8");
    expect(bg).toMatch(/<a href="en\/" hreflang="en" lang="en" data-code="en">English<\/a>/);
    expect(bg).toMatch(/<a href="\.\/" hreflang="bg" lang="bg" data-code="bg" aria-current="page">/);
    expect(bg).toContain("https://github.com/o/pub/blob/main/SECURITY.bg.md");
    expect(bg).not.toContain("{{PUBLIC_REPO}}");
    expect(bg).not.toContain("<!--seo:");
  });

  it("with SITE_URL: canonical, both language versions, share images, robots and a sitemap", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true, url: "https://example.test/", now: new Date("2026-10-28T10:00:00Z") });
    const bg = readFileSync(join(dist, "index.html"), "utf8");
    const en = readFileSync(join(dist, "en/index.html"), "utf8");
    expect(bg).toContain('<link rel="canonical" href="https://example.test/">');
    expect(en).toContain('<link rel="canonical" href="https://example.test/en/">');
    for (const page of [bg, en]) {
      expect(page).toContain('<link rel="alternate" hreflang="bg" href="https://example.test/">');
      expect(page).toContain('<link rel="alternate" hreflang="en" href="https://example.test/en/">');
      expect(page).toContain('<link rel="alternate" hreflang="x-default" href="https://example.test/">');
    }
    expect(bg).toContain('<meta property="og:image" content="https://example.test/og-bg.png">');
    expect(en).toContain('<meta property="og:image" content="https://example.test/og-en.png">');
    expect(existsSync(join(dist, "og-bg.png")) && existsSync(join(dist, "og-en.png"))).toBe(true);
    expect(readFileSync(join(dist, "robots.txt"), "utf8")).toContain("Sitemap: https://example.test/sitemap.xml");
    const map = readFileSync(join(dist, "sitemap.xml"), "utf8");
    expect(map).toContain("<loc>https://example.test/</loc>");
    expect(map).toContain("<loc>https://example.test/en/</loc>");
    expect(map).toContain("<lastmod>2026-10-28</lastmod>");
  });

  it("without SITE_URL no absolute address is invented", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], url: "" });
    expect(readFileSync(join(dist, "index.html"), "utf8")).not.toContain('rel="canonical"');
    expect(existsSync(join(dist, "sitemap.xml"))).toBe(false);
    expect(readFileSync(join(dist, "robots.txt"), "utf8")).toBe("User-agent: *\nAllow: /\n");
  });

  it("structured data repeats the questions and answers shown on each page", async () => {
    const dist = fakeDist();
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true, url: "https://example.test/" });
    for (const { path, html: lang } of LOCALES as Locale[]) {
      const file = `${path}index.html`;
      const page = readFileSync(join(dist, file), "utf8");
      const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
      const data = JSON.parse(json);
      expect(data[0]["@type"]).toBe("SoftwareApplication");
      expect(data[0].inLanguage).toBe(lang);
      const shown = [...page.matchAll(/<summary data-i18n="q\d">([^<]+)<\/summary>/g)].map((m) => m[1]);
      expect(shown.length).toBeGreaterThan(3);
      expect(data[1].mainEntity.map((q: { name: string }) => q.name)).toEqual(shown);
    }
  });

  it("rejects a SITE_URL that is not an absolute https address", () => {
    expect(siteUrl({})).toBe("");
    expect(siteUrl({ SITE_URL: "https://dyrakarmy.online" })).toBe("https://dyrakarmy.online/");
    expect(() => siteUrl({ SITE_URL: "http://x.test/" })).toThrow(/https/);
    expect(() => siteUrl({ SITE_URL: "x.test" })).toThrow(/https/);
  });

  it("keeps one variant of a when-block and drops the other", () => {
    const src = "a<!--when:open-->OPEN<!--/when--><!--when:closed-->CLOSED<!--/when-->b";
    expect(applyMode(src, { closed: false, lang: "bg" })).toBe("aOPENb");
    expect(applyMode(src, { closed: true, lang: "bg" })).toBe("aCLOSEDb");
  });

  it("reads the releases repository from RELEASES_REPO and rejects anything that is not owner/repo", () => {
    expect(releasesRepo({})).toBe("biramentv-ux/p2p-pure");
    expect(releasesRepo({ RELEASES_REPO: "o/pub" })).toBe("o/pub");
    expect(() => releasesRepo({ RELEASES_REPO: "o/pub; rm -rf /" })).toThrow(/owner\/repo/);
  });

  it("refuses to assemble without a built app", async () => {
    const d = mkdtempSync(join(tmpdir(), "site-"));
    dirs.push(d);
    await expect(assemble({ dist: join(d, "dist"), site: join(root, "site"), releases: [] })).rejects.toThrow(/build the app first/);
  });

  it("writes release data that can never close the script tag or run as code", () => {
    const html = '<script type="application/json" id="releases">{}</script><p>x</p>';
    const out = injectReleases(html, { evil: { name: "</script><script>alert(1)</script>", note: "a b" } });
    expect(out).not.toMatch(/<\/script><script>alert/);
    expect(out.match(/<\/script>/g)?.length).toBe(1);
    const json = out.match(/id="releases">([\s\S]*?)<\/script>/)![1];
    expect(JSON.parse(json).evil.name).toBe("</script><script>alert(1)</script>");
    expect(() => injectReleases("<p>no block</p>", {})).toThrow(/releases block/);
  });

  it("retires the old root service worker and its caches, and leaves the messenger's own cache alone", async () => {
    const deleted: string[] = [];
    let unregistered = false;
    const navigated: string[] = [];
    const listeners: Record<string, (e: { waitUntil(p: Promise<unknown>): void }) => void> = {};
    const self = {
      registration: { scope: "https://dyrakarmy.online/", unregister: async () => { unregistered = true; } },
      skipWaiting: () => {},
      clients: { matchAll: async () => [{ url: "https://dyrakarmy.online/", navigate: (u: string) => navigated.push(u) }] },
      addEventListener: (n: string, f: (e: { waitUntil(p: Promise<unknown>): void }) => void) => { listeners[n] = f; },
    };
    const caches = {
      keys: async () => ["workbox-precache-v2-https://dyrakarmy.online/", "workbox-precache-v2-https://dyrakarmy.online/app/", "other"],
      delete: async (n: string) => { deleted.push(n); return true; },
    };
    vm.runInNewContext(killSwitchWorker(), { self, caches });
    let pending: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p) => { pending = p; } });
    await pending;
    expect(deleted).toEqual(["workbox-precache-v2-https://dyrakarmy.online/"]);
    expect(unregistered).toBe(true);
    expect(navigated).toEqual(["https://dyrakarmy.online/"]);
  });
});

describe("the page", () => {
  const html = read("site/index.html");
  const css = read("site/site.css");
  const js = read("site/site.js");

  it("allows no inline script or style, no external origin, and no form", () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)![1];
    expect(csp).toMatch(/script-src 'self'(;|$)/);
    expect(csp).toMatch(/style-src 'self'(;|$)/);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toMatch(/connect-src 'self'(;|$)/);
    expect(html).not.toMatch(/<script(?![^>]*\b(src=|type="application\/json"))/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<form|<iframe|<img/i);
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).host);
    expect(new Set(external)).toEqual(new Set(["github.com"]));
    expect(css).not.toMatch(/url\(\s*["']?https?:/);
    expect(js + read("site/boot.js")).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|eval\(|new Function/);
  });

  it("has one h1, a skip link, and every in-page link lands on something", () => {
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(html).toMatch(/class="skip" href="#main"/);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1]), `#${m[1]}`).toBe(true);
    for (const m of html.matchAll(/aria-controls="([^"]+)"/g)) expect(ids.has(m[1]), m[1]).toBe(true);
  });

  it("translates every text key into English, and every Bulgarian-only key is provided", () => {
    const keys = new Set<string>();
    for (const m of html.matchAll(/data-i18n(?:-html|-aria)?="([^"]+)"/g)) keys.add(m[1]);
    for (const k of keys) expect(EN[k], `EN.${k}`).toBeTruthy();
    for (const k of ["title", "copied", "soon", "badgePreview", "badgeSoon", "ctaFor", "ctaOpenFor", "ctaWebFor", "demoMsgs", "osNames"]) {
      expect(BG_EXTRA[k], `BG_EXTRA.${k}`).toBeTruthy();
      expect(EN[k], `EN.${k}`).toBeTruthy();
    }
    expect(BG_EXTRA.demoMsgs.length).toBe(EN.demoMsgs.length);
    // the Bulgarian is the text in the page: no empty element left behind
    for (const m of html.matchAll(/<(\w+)[^>]*data-i18n="[^"]+"[^>]*>\s*<\/\1>/g)) throw new Error(`empty text in ${m[0]}`);
  });

  it("every palette index in the page exists in the script", () => {
    const palettes = js.match(/const PALETTES = \[(.*)\];/)![1].match(/\[[^\]]+\]/g)!.length;
    for (const m of html.matchAll(/data-palette="(\d+)"/g)) expect(Number(m[1])).toBeLessThan(palettes);
  });

  it("uses only the font files the build copies", () => {
    const wanted = new Set([...css.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]));
    const copied = new Set((FONT_FILES as [string, string][]).map(([, f]) => f));
    for (const f of wanted) expect(copied.has(f), f).toBe(true);
    for (const m of html.matchAll(/href="fonts\/([^"]+)"/g)) expect(copied.has(m[1]), m[1]).toBe(true);
  });

  it("switches every animation off for people who ask for less motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.001ms/);
    expect(js).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("sends an installed app straight to the messenger, and keeps the saved theme before the first paint", () => {
    const boot = read("site/boot.js");
    expect(boot).toMatch(/display-mode: standalone/);
    expect(boot).toMatch(/location\.replace\(base \+ "app\/"/);
    expect(boot).toMatch(/site-theme/);
  });

  it("opens the other language only when the visitor chose it before, never from a browser guess", () => {
    const boot = read("site/boot.js");
    expect(boot).toMatch(/localStorage\.getItem\("site-lang"\)/);
    expect(boot).not.toMatch(/navigator\.language/);
    expect(js).not.toMatch(/navigator\.language/);
    expect(read("site/index.html")).toMatch(/<html lang="bg"[^>]*data-lang="bg" data-langs="bg en es pt fr de ru zh"/);
  });

  // boot.js is a classic script: run it with a stand-in page and see where it sends the visitor
  function boot(page: { lang: string; root: string }, chosen: string | null) {
    const attrs: Record<string, string> = { "data-lang": page.lang, "data-langs": (LOCALES as Locale[]).map((l) => l.code).join(" "), "data-root": page.root };
    let went = "";
    const documentElement = { lang: page.lang, classList: { add() {} }, getAttribute: (k: string) => attrs[k] ?? null, setAttribute() {} };
    vm.runInNewContext(read("site/boot.js"), {
      document: { documentElement },
      window: { matchMedia: () => ({ matches: false }), navigator: {} },
      localStorage: { getItem: (k: string) => (k === "site-lang" ? chosen : null) },
      location: { search: "", hash: "", replace: (u: string) => { went = u; } },
    });
    return went;
  }

  it("opens the remembered language from any page, and stays put otherwise", () => {
    expect(boot({ lang: "bg", root: "" }, "es")).toBe("es/");
    expect(boot({ lang: "bg", root: "" }, "zh")).toBe("zh/");
    expect(boot({ lang: "de", root: "../" }, "fr")).toBe("../fr/");
    expect(boot({ lang: "ru", root: "../" }, "bg")).toBe("../");
    expect(boot({ lang: "pt", root: "../" }, "pt")).toBe("");
    expect(boot({ lang: "bg", root: "" }, null)).toBe("");
    expect(boot({ lang: "bg", root: "" }, "xx")).toBe(""); // not a language of the site
  });
});

describe("translations (site/i18n/<code>.js)", () => {
  const tags = (v: string) => [...v.matchAll(/<\/?[a-z][^>]*>|\{\w+\}/gi)].map((m) => m[0]).sort();
  // brand and technical names that stay as they are, so they are not counted by the script check
  const KEEP = /P2P Messenger|Double Ratchet|WebRTC|Passkey|AES-GCM|DTLS-SRTP|SHA-256|SBOM|GitHub|Worker|TURN|STUN|QR|Wi.?Fi|Windows|Linux|Android|iPhone|Mac|Chrome|Edge|Firefox|Safari|App Store|SmartScreen|install\.sh|\.exe|\.apk|\.zip|MB|Mo|МБ/g;
  const OPEN_ANY = /open[ -]?source|código (abierto|aberto)|quelloffen|offene[nrs]? (quell)?code|открыт\w* код|开源|公开/i;
  const texts = (pack: Record<string, unknown>) => Object.entries(pack).filter(([k]) => k !== "closed" && k !== "osNames");

  it("the registry is complete: every language has its own folder, a pack and a name", () => {
    expect((LOCALES as Locale[]).map((l) => l.code)).toEqual(["bg", "en", "es", "pt", "fr", "de", "ru", "zh"]);
    expect(new Set((LOCALES as Locale[]).map((l) => l.path)).size).toBe(LOCALES.length);
    for (const l of FOREIGN) expect(packs[l.code], l.code).toBeTruthy();
  });

  for (const l of FOREIGN) {
    describe(l.name, () => {
      const pack = () => packs[l.code];

      it("has exactly the English keys, none empty", () => {
        const { closed, ...rest } = pack();
        expect(Object.keys(rest).sort()).toEqual(Object.keys(EN).sort());
        for (const [k, v] of texts(pack())) {
          if (Array.isArray(v)) for (const x of v) expect(String(x).trim(), `${l.code}.${k}`).not.toBe("");
          else expect(String(v).trim(), `${l.code}.${k}`).not.toBe("");
        }
        expect(pack().demoMsgs.length).toBe(EN.demoMsgs.length);
        expect(Object.keys(pack().osNames).sort()).toEqual(Object.keys(EN.osNames).sort());
        expect(Object.keys(closed).sort()).toEqual([...CLOSED_KEYS].sort());
      });

      it("keeps every tag and placeholder of the English text", () => {
        for (const [k, v] of texts(pack())) if (typeof v === "string") expect(tags(v), `${l.code}.${k}`).toEqual(tags(EN[k]));
        for (const k of CLOSED_KEYS as string[]) {
          if (k === "marquee") expect(tags(pack().closed[k]).length, `${l.code}.closed.${k}`).toBe(tags(EN[k]).length);
          else expect(tags(pack().closed[k]), `${l.code}.closed.${k}`).toEqual(tags(EN[k]));
        }
      });

      it(`is written in ${l.scripts.join("/")}, not copied from English`, () => {
        const all = texts(pack()).flatMap(([, v]) => (Array.isArray(v) ? v : [v])).map(String).join(" ");
        const letters = all.replace(/<[^>]*>|\{\w+\}/g, " ").replace(KEEP, " ").match(/\p{L}/gu) ?? [];
        const own = letters.filter((c) => l.scripts.some((sc) => new RegExp(`\\p{Script=${sc}}`, "u").test(c)));
        expect(own.length / letters.length).toBeGreaterThan(0.8);
        // short labels can be the same word ("Menu", "Download", "Links"); a whole sentence cannot
        const same = texts(pack()).filter(([k, v]) => typeof v === "string" && v === EN[k] && v.split(/\s+/).length > 3);
        expect(same.map(([k]) => k)).toEqual([]);
      });

      it("the private-source wording claims no open code", () => {
        for (const k of CLOSED_KEYS as string[]) expect(pack().closed[k], `${l.code}.closed.${k}`).not.toMatch(OPEN_ANY);
      });
    });
  }
});

describe("the language pages", () => {
  it("builds one page per language with its own title, lang, menu, alternates and sitemap entry", async () => {
    const dist = mkdtempSync(join(tmpdir(), "site-langs-"));
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true, url: "https://example.test/" });
    const map = readFileSync(join(dist, "sitemap.xml"), "utf8");
    for (const l of LOCALES as Locale[]) {
      const page = readFileSync(join(dist, l.path, "index.html"), "utf8");
      expect(page, l.code).toMatch(new RegExp(`<html lang="${l.html}"[^>]*data-lang="${l.code}"`));
      expect(page).toContain(`<span data-lang-current="">${l.short}</span>`);
      expect(page).toContain(`data-code="${l.code}" aria-current="page">${l.name}</a>`);
      expect(page.match(/aria-current="page"/g)!.length).toBe(1);
      for (const o of LOCALES as Locale[]) expect(page).toContain(`<link rel="alternate" hreflang="${o.html}" href="https://example.test/${o.path}">`);
      expect(page).toContain(`<meta property="og:locale" content="${l.og}">`);
      expect(page).not.toMatch(OPEN_CLAIM);
      expect(map).toContain(`<loc>https://example.test/${l.path}</loc>`);
      if (l.code === "bg") continue;
      const pack = l.code === "en" ? EN : packs[l.code];
      const title = /<title>([^<]*)<\/title>/.exec(page)![1];
      expect(title).toBe(String(pack.title).replaceAll("&", "&amp;"));
      expect(page).not.toContain("Писмата ти"); // no Bulgarian left on a foreign page
      expect(page).toContain('href="../site.css"');
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)![1]);
      expect(ld[0].inLanguage).toBe(l.html);
    }
    rmSync(dist, { recursive: true, force: true });
  });

  it("uses the private-source wording of each language in closed mode, and the open one otherwise", async () => {
    for (const closed of [true, false]) {
      const dist = mkdtempSync(join(tmpdir(), "site-mode-"));
      writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
      await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed, url: "" });
      for (const l of FOREIGN) {
        const page = readFileSync(join(dist, l.path, "index.html"), "utf8");
        const sec1t = /<b data-i18n="sec1t">([^<]*)<\/b>/.exec(page)?.[1] ?? /data-i18n="sec1t"[^>]*>([^<]*)</.exec(page)?.[1];
        expect(sec1t, l.code).toBe(closed ? packs[l.code].closed.sec1t : packs[l.code].sec1t);
      }
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("the six ways to connect", () => {
  const html = read("site/index.html");
  it("sits between how and security, is in the menu, and has six cards with an animation each", () => {
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("how")).toBeGreaterThan(0);
    expect(at("connect")).toBeGreaterThan(at("how"));
    expect(at("security")).toBeGreaterThan(at("connect"));
    expect(html).toMatch(/<section class="connect" id="connect" data-palette="\d+"/);
    expect(html.match(/href="#connect"/g)?.length).toBe(2); // top menu and full-screen menu
    const section = /<section class="connect"[\s\S]*?<\/section>/.exec(html)![0];
    expect(section.match(/<article class="card way /g)?.length).toBe(6);
    expect(section.match(/<svg class="art"/g)?.length).toBe(6);
    expect(section).not.toMatch(/\sstyle=|<img|<canvas|<video/i);
  });

  it("is built with six cards in every language, none left in Bulgarian", async () => {
    const dist = mkdtempSync(join(tmpdir(), "site-ways-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
    await assemble({ dist, site: join(root, "site"), releases: [], repo: "o/pub", closed: true, url: "" });
    for (const l of LOCALES as Locale[]) {
      const page = readFileSync(join(dist, l.path, "index.html"), "utf8");
      const section = /<section class="connect"[\s\S]*?<\/section>/.exec(page)?.[0] ?? "";
      expect(section, l.code).not.toBe("");
      expect(section.match(/<article class="card way /g)?.length, l.code).toBe(6);
      for (const k of ["w1t", "w2t", "w3t", "w4t", "w5t", "w6t", "w1p", "w6p", "wayWhen", "connLead"]) {
        const text = new RegExp(`data-i18n="${k}">([^<]+)<`).exec(section)?.[1];
        expect(text, `${l.code}.${k}`).toBeTruthy();
        if (l.code !== "bg") expect(/[\u0400-\u04FF]/.test(text!) && l.code !== "ru", `${l.code}.${k}`).toBe(false);
      }
    }
    rmSync(dist, { recursive: true, force: true });
  });

  it("scenes pause off-screen and for people who ask for less motion", () => {
    const css = read("site/site.css");
    const js = read("site/site.js");
    expect(css).toMatch(/\.js \.way:not\(\.live\) \.art \* \{ animation-play-state: paused/);
    expect(js).toMatch(/classList\.toggle\("live", en\.isIntersecting\)/);
    // transform and opacity only: nothing in the scenes' keyframes moves layout
    for (const m of css.matchAll(/@keyframes (w-[\w-]+) \{(.*)\}/g)) expect(m[2], m[1]).not.toMatch(/\b(width|height|top|left|margin|stroke-dash\w*)\s*:/);
  });
});

describe("publishing", () => {
  const wf = read(".github/workflows/pages.yml");
  it("passes the public address to the build when the site has its own domain", () => {
    expect(wf).toContain("SITE_URL: ${{ vars.PAGES_DOMAIN != '' && format('https://{0}/', vars.PAGES_DOMAIN) || '' }}");
  });
  it("builds through the site script, so the app lands under /app/", () => {
    expect(wf).toMatch(/node scripts\/site\/build\.mjs --build --base "\$PAGES_BASE"/);
    expect(wf).not.toMatch(/run: npm run build\b/);
    for (const line of wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line, line).toMatch(/@[0-9a-f]{40}\b/);
  });
  it("rebuilds after every release workflow, so the download buttons show the newest files", () => {
    for (const name of ["Linux desktop", "Windows desktop", "Android APK"]) expect(wf).toContain(`"${name}"`);
  });
  it("publishes to a public repository only when PAGES_PUBLISH_REPO is set, keeping hidden files", () => {
    expect(wf).toContain("vars.PAGES_PUBLISH_REPO != ''");
    // handed to the publish job through the cache: artifacts fill the account's storage quota
    expect(wf).toMatch(/actions\/cache\/save@[0-9a-f]{40}/);
    expect(wf).toMatch(/actions\/cache\/restore@[0-9a-f]{40}/);
    expect(wf).toContain("fail-on-cache-miss: true");
    expect(wf).not.toMatch(/upload-artifact|download-artifact/);
    expect(wf).toMatch(/if: vars\.PAGES_PUBLISH_REPO == ''/);
    expect(wf).not.toMatch(/RELEASES_TOKEN\s*\}\}\s*\n\s*run:[^\n]*echo/);
  });
  it("leaves the desktop and mobile packages on a plain app build", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["build:desktop"]).toBe("tsc -b && vite build --mode desktop");
    expect(pkg.scripts["cap:sync"]).toBe("vite build && npx cap sync");
  });
  it("points the extension at the messenger, not the site", () => {
    expect(read("extension/launch.js")).toMatch(/APP_URL = "https:\/\/dyrakarmy\.online\/app\/"/);
  });
});

