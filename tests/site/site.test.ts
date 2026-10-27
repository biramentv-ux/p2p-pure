// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ES modules, shared with the browser
import { detectOS, formatSize, pickDownloads, versionOf } from "../../site/downloads.js";
// @ts-expect-error plain ES module script
import { FONT_FILES, assemble, injectReleases, killSwitchWorker } from "../../scripts/site/build.mjs";
// @ts-expect-error plain ES module
import { BG_EXTRA, EN } from "../../site/i18n.js";

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
    expect(boot).toMatch(/location\.replace\("app\/"/);
    expect(boot).toMatch(/site-theme/);
  });
});

describe("publishing", () => {
  const wf = read(".github/workflows/pages.yml");
  it("builds through the site script, so the app lands under /app/", () => {
    expect(wf).toMatch(/node scripts\/site\/build\.mjs --build --base "\$PAGES_BASE"/);
    expect(wf).not.toMatch(/run: npm run build\b/);
    for (const line of wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line, line).toMatch(/@[0-9a-f]{40}\b/);
  });
  it("rebuilds after every release workflow, so the download buttons show the newest files", () => {
    for (const name of ["Linux desktop", "Windows desktop", "Android APK"]) expect(wf).toContain(`"${name}"`);
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

