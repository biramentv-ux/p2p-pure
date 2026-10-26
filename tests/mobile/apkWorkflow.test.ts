// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("Android APK build", () => {
  const wf = read(".github/workflows/android-apk.yml");
  const gradle = read("android/app/build.gradle");
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  it("pins every action to a commit and keeps write access to the release job only", () => {
    for (const line of wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) {
      expect(line, line).toMatch(/@[0-9a-f]{40}\b/);
    }
    expect(wf.match(/^permissions:\n  contents: read/m)).not.toBeNull();
    expect(wf.match(/contents: write/g)?.length).toBe(1);
  });

  it("builds the web app with the real passkey domain, not the WebView's localhost", () => {
    expect(wf).toMatch(/VITE_PASSKEY_RP_ID: \$\{\{ vars\.PASSKEY_RP_ID \|\| 'dyrakarmy\.online' \}\}/);
  });

  it("never puts a secret in the command line or the log", () => {
    expect(wf).not.toMatch(/-PapkKey|--ks-pass|storepass\s+["']?\$\{\{/);
    expect(wf).toMatch(/::add-mask::/);
  });

  it("ships a release build that is not debuggable and signs it from the environment", () => {
    expect(gradle).toMatch(/debuggable false/);
    expect(gradle).toMatch(/System\.getenv\('ANDROID_KEYSTORE_PATH'\)/);
    expect(gradle).not.toMatch(/storePassword\s+["'][^"']+["']/);
  });

  it("keeps the app's data out of any backup or transfer", () => {
    expect(manifest).toMatch(/android:allowBackup="false"/);
    const rules = read("android/app/src/main/res/xml/data_extraction_rules.xml");
    expect(rules).toMatch(/<cloud-backup>[\s\S]*<exclude domain="database" \/>[\s\S]*<\/cloud-backup>/);
    expect(rules).toMatch(/<device-transfer>[\s\S]*<exclude domain="file" \/>[\s\S]*<\/device-transfer>/);
  });
});
