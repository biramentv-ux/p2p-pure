/**
 * Static checks for the mobile packages. They read the files and check that the
 * identifiers agree across the web app, the Capacitor config, the Android and iOS
 * overlays and the Digital Asset Links / associated-domains files. Nothing is compiled.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

const APP_ID = /appId:\s*'([^']+)'/.exec(read("capacitor.config.ts"))?.[1];
const JAVA_DIR = "native-overlays/android/java/bg/p2pmessenger/app";
const RP_ID = "dyrakarmy.online";

describe("bundle id and package name", () => {
  it("capacitor appId is the reverse-DNS id used everywhere", () => {
    expect(APP_ID).toBe("bg.p2pmessenger.app");
  });

  it("Java package path matches the appId", () => {
    const pkg = `package ${APP_ID};`;
    expect(read(`${JAVA_DIR}/PasskeyBridgePlugin.java`)).toContain(pkg);
    expect(read(`${JAVA_DIR}/MainActivity.java`)).toContain(pkg);
    expect(APP_ID!.split(".").join("/")).toBe("bg/p2pmessenger/app");
  });

  it("Digital Asset Links files name the appId as package", () => {
    for (const f of ["public/.well-known/assetlinks.json", "native-overlays/android/assetlinks.json.template"]) {
      const data = JSON.parse(read(f)) as Array<{ target: { package_name: string; namespace: string } }>;
      expect(data[0].target.namespace).toBe("android_app");
      expect(data[0].target.package_name).toBe(APP_ID);
    }
  });

  it("apple-app-site-association lists the appId for webcredentials", () => {
    const aasa = JSON.parse(read("public/.well-known/apple-app-site-association")) as {
      webcredentials: { apps: string[] };
    };
    expect(aasa.webcredentials.apps.some((a) => a.endsWith(`.${APP_ID}`))).toBe(true);
  });

  it("iOS entitlements grant webcredentials for the rpId domain", () => {
    expect(read("native-overlays/ios/App.entitlements.template")).toContain(`webcredentials:${RP_ID}`);
  });
});

describe("plugin wiring", () => {
  it("JS and Java use the same plugin name", () => {
    const js = read("src/platform/mobile/nativePasskeys.ts");
    const java = read(`${JAVA_DIR}/PasskeyBridgePlugin.java`);
    expect(js).toContain('registerPlugin<PasskeyBridgePlugin>("PasskeyBridge")');
    expect(java).toContain('@CapacitorPlugin(name = "PasskeyBridge")');
    expect(java).toMatch(/public void create\(PluginCall call\)/);
    expect(java).toMatch(/public void get\(PluginCall call\)/);
  });

  it("MainActivity registers the plugin before super.onCreate", () => {
    const src = read(`${JAVA_DIR}/MainActivity.java`);
    expect(src.indexOf("registerPlugin(PasskeyBridgePlugin.class)")).toBeGreaterThan(-1);
    expect(src.indexOf("registerPlugin(PasskeyBridgePlugin.class)")).toBeLessThan(src.indexOf("super.onCreate(savedInstanceState)"));
  });

  it("the plugin replies with the same key the JS side reads", () => {
    expect(read(`${JAVA_DIR}/PasskeyBridgePlugin.java`)).toContain('out.put("responseJson"');
    expect(read("src/platform/mobile/nativePasskeys.ts")).toContain("responseJson");
  });

  it("the Java plugin is the only Android bridge source (no Kotlin leftovers)", () => {
    expect(exists("native-overlays/android/PasskeyBridgePlugin.kt")).toBe(false);
    expect(exists("native-overlays/android/MainActivity.snippet.kt")).toBe(false);
  });
});

describe("native projects match the overlays", () => {
  it.skipIf(!exists("android/app/build.gradle") && !exists("ios/App/App/Info.plist"))(
    "scripts/mobile/sync-overlays.mjs --check passes",
    () => {
      execFileSync(process.execPath, [path.join(ROOT, "scripts/mobile/sync-overlays.mjs"), "--check"], {
        stdio: "pipe",
      });
    },
  );

  it.skipIf(!exists("android/app/build.gradle"))("Android manifest asks for the camera", () => {
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain("android.permission.CAMERA");
  });

  it.skipIf(!exists("ios/App/App/Info.plist"))("iOS Info.plist has a camera usage description", () => {
    expect(read("ios/App/App/Info.plist")).toContain("NSCameraUsageDescription");
  });
});

describe("web app is configured for the native rpId", () => {
  it("build reads VITE_PASSKEY_RP_ID through the bridge", () => {
    expect(read("src/platform/mobile/webBridge.ts")).toContain("VITE_PASSKEY_RP_ID");
  });
});
