// @vitest-environment node
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { mimeFor, resolveAppFile } from "../../electron/appFiles.mjs";

const ROOT = "/opt/app-dist";
// The same checks run on the Windows CI runner, where resolve() gives "D:\\opt\\app-dist\\…".
const BASE = resolve(ROOT);
const inBase = (...parts: string[]) => join(BASE, ...parts);
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("Linux shell: which files a request may read", () => {
  it("maps the app's own addresses into the bundle folder", () => {
    expect(resolveAppFile(ROOT, "app://p2p/")).toBe(inBase("index.html"));
    expect(resolveAppFile(ROOT, "app://p2p")).toBe(inBase("index.html"));
    expect(resolveAppFile(ROOT, "app://p2p/index.html")).toBe(inBase("index.html"));
    expect(resolveAppFile(ROOT, "app://p2p/assets/app-abc123.js?x=1#y")).toBe(inBase("assets", "app-abc123.js"));
    expect(resolveAppFile(ROOT, "app://p2p/icons/icon-192.png")).toBe(inBase("icons", "icon-192.png"));
  });

  it.each([
    "app://p2p/..%5c..%5cwindows",
    "app://p2p/a%00.js",
    "app://p2p/%zz",
    "app://evil/index.html",
    "app://p2p.evil/index.html",
    "https://p2p/index.html",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s", (url) => {
    expect(resolveAppFile(ROOT, url)).toBeNull();
  });

  it("never gives back a path outside the folder", () => {
    const tricks = ["/a", "/a/b/../c", "//x", "/./y", "/assets//z.js", "/../etc/passwd", "/assets/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/%2E%2E%2fetc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e%2f%2e%2e%2fetc/passwd"];
    for (const path of tricks) {
      const file = resolveAppFile(ROOT, `app://p2p${path}`);
      expect(file === null || file.startsWith(BASE + sep)).toBe(true);
    }
  });

  it("sends unknown types as plain bytes, never as HTML", () => {
    expect(mimeFor("a.js")).toContain("javascript");
    expect(mimeFor("a.wasm")).toBe("application/wasm");
    expect(mimeFor("A.PNG")).toBe("image/png");
    expect(mimeFor("a.exe")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

describe("Linux shell: hardening that must not be switched off by accident", () => {
  const main = read("electron/main.mjs");
  const pkg = JSON.parse(read("electron/package.json"));

  it("keeps the page isolated from Node.js and sandboxed", () => {
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/sandbox:\s*true/);
    expect(main).toMatch(/nodeIntegration:\s*false/);
    expect(main).toMatch(/webSecurity:\s*true/);
    expect(main).toMatch(/webviewTag:\s*false/);
    expect(main).not.toMatch(/--no-sandbox|no-sandbox|disable-web-security|allowRunningInsecureContent:\s*true/);
  });

  it("has one preload, for the native transport only (П4), with no Node in the page", () => {
    // The only preload is electron/preload.cjs: sandboxed, contextBridge + ipcRenderer, one object.
    expect(main.match(/preload:/g)?.length).toBe(1);
    expect(main).toMatch(/preload: join\(here, "preload\.cjs"\)/);
    const preload = read("electron/preload.cjs");
    expect(preload.match(/require\(/g)?.length).toBe(1);
    expect(preload).toMatch(/const \{ contextBridge, ipcRenderer \} = require\("electron"\)/);
    expect(preload.match(/exposeInMainWorld\(/g)?.length).toBe(1);
    expect(preload).toMatch(/exposeInMainWorld\("p2pNative"/);
    expect(preload).not.toMatch(/process\.|child_process|fs\b|shell\./);
    // The main process answers the page's native calls only from the app's own origin.
    expect(main).toMatch(/const own = \(e\) => typeof e\.senderFrame\?\.url === "string" && e\.senderFrame\.url\.startsWith\(`\$\{ORIGIN\}\/`\)/);
    for (const ch of ["open", "send", "close", "ssdp", "http"]) expect(main).toMatch(new RegExp(`p2p-native:${ch}", \\(e[^)]*\\) => \\{?\\s*\\(?\\s*(if \\()?own\\(e\\)`));
  });

  it("allows only camera and microphone, only for its own pages, and never leaves the app", () => {
    expect(main).toMatch(/new Set\(\["media", "clipboard-sanitized-write"\]\)/);
    expect(main).toMatch(/allowed\.has\(permission\) && own\(/);
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/setWindowOpenHandler/);
    expect(main).toMatch(/action: "deny"/);
    expect(main).toMatch(/\^https:\\\/\\\//);
  });

  it("switches off the Electron features that would let outside code in", () => {
    const fuses = pkg.build.electronFuses;
    expect(fuses.runAsNode).toBe(false);
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(false);
    expect(fuses.enableNodeCliInspectArguments).toBe(false);
    expect(fuses.onlyLoadAppFromAsar).toBe(true);
    expect(pkg.build.asar).toBe(true);
    expect(pkg.build.publish).toBeNull();
  });

  it("pins its build tools to exact versions", () => {
    for (const [name, version] of Object.entries(pkg.devDependencies as Record<string, string>)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(pkg.dependencies).toBeUndefined();
  });

  it("has the same version as the Windows app", () => {
    const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(pkg.version).toBe(tauri.version);
    expect(pkg.build.appId).toBe(tauri.identifier);
  });
});
