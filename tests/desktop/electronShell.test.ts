// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mimeFor, resolveAppFile } from "../../electron/appFiles.mjs";

const ROOT = "/opt/app-dist";
const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("Linux shell: which files a request may read", () => {
  it("maps the app's own addresses into the bundle folder", () => {
    expect(resolveAppFile(ROOT, "app://p2p/")).toBe("/opt/app-dist/index.html");
    expect(resolveAppFile(ROOT, "app://p2p")).toBe("/opt/app-dist/index.html");
    expect(resolveAppFile(ROOT, "app://p2p/index.html")).toBe("/opt/app-dist/index.html");
    expect(resolveAppFile(ROOT, "app://p2p/assets/app-abc123.js?x=1#y")).toBe("/opt/app-dist/assets/app-abc123.js");
    expect(resolveAppFile(ROOT, "app://p2p/icons/icon-192.png")).toBe("/opt/app-dist/icons/icon-192.png");
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
      expect(file === null || file.startsWith(ROOT + "/")).toBe(true);
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
    expect(main).not.toMatch(/preload/);
    expect(main).not.toMatch(/--no-sandbox|no-sandbox|disable-web-security|allowRunningInsecureContent:\s*true/);
  });

  it("allows only camera and microphone, only for its own pages, and never leaves the app", () => {
    expect(main).toMatch(/permission === "media" && own\(/);
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
