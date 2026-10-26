/** Static checks for the F-Droid metadata: files exist, limits hold, versions agree. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const gradle = read("android/app/build.gradle");
const versionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? "";
const versionCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]);
const pkgVersion = (JSON.parse(read("package.json")) as { version: string }).version;
const LOCALES = ["en-US", "bg"];
const META = "fastlane/metadata/android";

describe("F-Droid versions", () => {
  it("versionName equals package.json version", () => {
    expect(versionName).toBe(pkgVersion);
  });

  it("versionCode is derived from the version (major*10000 + minor*100 + patch)", () => {
    const [major, minor, patch] = versionName.split(".").map(Number);
    expect(versionCode).toBe(major * 10000 + minor * 100 + patch);
  });

  it("package-lock root version matches", () => {
    const lock = JSON.parse(read("package-lock.json")) as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe(pkgVersion);
    expect(lock.packages[""].version).toBe(pkgVersion);
  });

  it("fdroiddata draft matches the app", () => {
    const y = read("docs/fdroid/bg.p2pmessenger.app.yml");
    expect(y).toContain(`versionName: ${versionName}`);
    expect(y).toContain(`versionCode: ${versionCode}`);
    expect(y).toContain(`CurrentVersion: ${versionName}`);
    expect(y).toContain(`CurrentVersionCode: ${versionCode}`);
    expect(y).toContain(`commit: android-v${versionName}`);
    expect(y).toContain("AutoUpdateMode: Version android-v%v");
    expect(y).toContain("Repo: https://github.com/biramentv-ux/p2p-pure.git");
  });

  it("fdroiddata draft strips the proprietary Play Services dependency", () => {
    expect(read("docs/fdroid/bg.p2pmessenger.app.yml")).toContain("credentials-play-services-auth");
  });

  it("applicationId is the F-Droid package id", () => {
    expect(gradle).toContain('applicationId "bg.p2pmessenger.app"');
  });
});

describe.each(LOCALES)("fastlane metadata (%s)", (loc) => {
  const dir = `${META}/${loc}`;

  it("has title, short and full description within store limits", () => {
    expect(read(`${dir}/title.txt`).length).toBeGreaterThan(0);
    expect(read(`${dir}/title.txt`).length).toBeLessThanOrEqual(30);
    const short = read(`${dir}/short_description.txt`);
    expect([...short].length).toBeGreaterThan(0);
    expect([...short].length).toBeLessThanOrEqual(80);
    const full = read(`${dir}/full_description.txt`);
    expect(full.length).toBeGreaterThan(100);
    expect(Buffer.byteLength(full)).toBeLessThanOrEqual(4000);
  });

  it("has a changelog for the current versionCode (max 500 bytes)", () => {
    const f = `${dir}/changelogs/${versionCode}.txt`;
    expect(exists(f)).toBe(true);
    expect(Buffer.byteLength(read(f))).toBeLessThanOrEqual(500);
  });

  it("has a real PNG icon", () => {
    const buf = fs.readFileSync(path.join(ROOT, `${dir}/images/icon.png`));
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("docs", () => {
  it("ANDROID.md exists and mentions F-Droid and sideload", () => {
    const t = read("docs/ANDROID.md");
    expect(t).toContain("F-Droid");
    expect(t).toContain("sideload");
  });
});
