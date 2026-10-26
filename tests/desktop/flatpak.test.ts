// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const APP_ID = "bg.p2pmessenger.app";
const manifest = read(`flatpak/${APP_ID}.yml`);
// Comments are explanations, not configuration: the checks look at the real lines only.
const lines = manifest.split("\n").filter((l) => !/^\s*#/.test(l));
const code = lines.join("\n");

const finishArgs = lines
  .map((l) => /^\s{2}- (--\S+)/.exec(l)?.[1])
  .filter((a): a is string => Boolean(a));

describe("Flatpak manifest: identity and runtime", () => {
  it("uses the app id for the file, the metainfo, the desktop file and the manifest", () => {
    expect(code).toMatch(new RegExp(`^app-id: ${APP_ID.replaceAll(".", "\\.")}$`, "m"));
    expect(read(`flatpak/${APP_ID}.metainfo.xml`)).toContain(`<id>${APP_ID}</id>`);
    expect(read(`flatpak/${APP_ID}.metainfo.xml`)).toContain(`<launchable type="desktop-id">${APP_ID}.desktop</launchable>`);
    expect(read(`flatpak/${APP_ID}.desktop`)).toContain(`Icon=${APP_ID}`);
  });

  it("builds on the freedesktop runtime and the Electron base app, same branch", () => {
    expect(code).toMatch(/^runtime: org\.freedesktop\.Platform$/m);
    expect(code).toMatch(/^sdk: org\.freedesktop\.Sdk$/m);
    expect(code).toMatch(/^base: org\.electronjs\.Electron2\.BaseApp$/m);
    const rt = /^runtime-version: '([^']+)'$/m.exec(code)?.[1];
    const bs = /^base-version: '([^']+)'$/m.exec(code)?.[1];
    expect(rt).toMatch(/^\d{2}\.\d{2}$/);
    expect(bs).toBe(rt);
  });

  it("starts the program that the script installs", () => {
    expect(code).toMatch(/^command: p2p-messenger$/m);
    expect(code).toContain("/app/bin/p2p-messenger");
    expect(read("flatpak/p2p-messenger.sh")).toContain("zypak-wrapper /app/lib/p2p-messenger/p2p-messenger");
  });
});

describe("Flatpak manifest: hardening", () => {
  it("has the permissions the app needs", () => {
    expect(finishArgs).toEqual(expect.arrayContaining(["--share=network", "--socket=wayland", "--socket=fallback-x11"]));
  });

  it("gives no access to the host files", () => {
    expect(finishArgs.filter((a) => /^--(no)?filesystem/.test(a))).toEqual([]);
    expect(code).not.toMatch(/filesystem=/);
    expect(code).not.toMatch(/--persist/);
  });

  it("gives no access to the buses, agents, or the Flatpak/devel escape hatches", () => {
    const forbidden = [
      /^--socket=(session-bus|system-bus|ssh-auth|gpg-agent|pcsc|cups|x11)$/,
      /^--system-/,
      /^--own-name/,
      /^--talk-name=org\.freedesktop\.Flatpak/,
      /^--talk-name=org\.freedesktop\.(systemd1|login1|PolicyKit1)/,
      /^--allow=(devel|multiarch|bluetooth|per-app-dev-shm)/,
      /^--share=(?!network$|ipc$)/,
      /^--device=(?!all$)/,
    ];
    for (const a of finishArgs) for (const re of forbidden) expect({ a, bad: re.test(a) }).toEqual({ a, bad: false });
  });

  it("only talks to the bus names it needs", () => {
    const names = finishArgs.filter((a) => a.startsWith("--talk-name=")).sort();
    expect(names).toEqual(["--talk-name=org.freedesktop.Notifications", "--talk-name=org.freedesktop.secrets"]);
  });

  it("does not ship the setuid helper (zypak is the sandbox here)", () => {
    expect(code).toContain("rm -f /app/lib/p2p-messenger/chrome-sandbox");
    expect(read("flatpak/p2p-messenger.sh")).not.toMatch(/--no-sandbox/);
  });
});

describe("Flatpak manifest: sources are pinned", () => {
  const blocks = code.split(/\n\s{6}- type: /).slice(1);
  it("has sources, and every one is a local file or a checksummed archive", () => {
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      const type = b.split("\n")[0].trim();
      expect(["archive", "file"]).toContain(type);
      expect(b).not.toMatch(/^\s+url:/m); // nothing is fetched while building
      expect(b).not.toMatch(/branch:|tag:/);
    }
  });

  it("pins the archive with a SHA-256 (the template placeholder is the only exception)", () => {
    const archives = blocks.filter((b) => b.startsWith("archive"));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^\s+sha256: '(?:[0-9a-f]{64}|@APP_SHA256@)'$/m);
  });

  it("the build script fills the placeholder and refuses to build with one left", () => {
    const sh = read("scripts/linux/build-flatpak.sh");
    expect(sh).toContain("@APP_SHA256@");
    expect(sh).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(sh).toMatch(/grep -q '@APP_SHA256@'/);
  });

  it("pins the third-party actions of the flatpak job to commit SHAs", () => {
    const wf = read(".github/workflows/linux-desktop.yml");
    for (const m of wf.matchAll(/^\s*- uses: (\S+)/gm)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe("Flatpak metadata", () => {
  const version = JSON.parse(read("electron/package.json")).version as string;
  const meta = read(`flatpak/${APP_ID}.metainfo.xml`);

  it("lists the version of the Electron package as a release", () => {
    expect(meta).toContain(`<release version="${version}"`);
  });

  it("has a license and no remote scripts or secrets", () => {
    expect(meta).toContain("<project_license>MIT</project_license>");
    for (const f of [manifest, meta, read("flatpak/p2p-messenger.sh"), read("scripts/linux/build-flatpak.sh")]) {
      expect(f).not.toMatch(/ghp_|github_pat_|BEGIN (?:PGP|RSA|OPENSSH)|curl[^\n]*\|\s*(?:ba)?sh/);
    }
  });

  it("the desktop file starts the installed command", () => {
    const d = read(`flatpak/${APP_ID}.desktop`);
    expect(d).toMatch(/^Exec=p2p-messenger( %U)?$/m);
    expect(d).toMatch(/^StartupWMClass=p2p-messenger$/m);
  });
});
