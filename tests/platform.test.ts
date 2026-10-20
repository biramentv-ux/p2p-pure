import { describe, it, expect } from "vitest";
import { createWebBridge, detectKind, resolveRpId } from "../src/platform/mobile";

describe("rpId resolution", () => {
  it("uses the host when nothing is configured", () => {
    expect(resolveRpId("dyrakarmy.online")).toBe("dyrakarmy.online");
    expect(resolveRpId("localhost", "")).toBe("localhost");
  });

  it("accepts a configured rpId that is the host or its parent domain", () => {
    expect(resolveRpId("dyrakarmy.online", "dyrakarmy.online")).toBe("dyrakarmy.online");
    expect(resolveRpId("app.dyrakarmy.online", "dyrakarmy.online")).toBe("dyrakarmy.online");
  });

  it("ignores a configured rpId the browser would reject", () => {
    expect(resolveRpId("localhost", "dyrakarmy.online")).toBe("localhost");
    expect(resolveRpId("evildyrakarmy.online", "dyrakarmy.online")).toBe("evildyrakarmy.online");
  });

  it("is case-insensitive", () => {
    expect(resolveRpId("DyrakArmy.Online", "dyrakarmy.ONLINE")).toBe("dyrakarmy.online");
  });
});

describe("platform detection", () => {
  it("maps Capacitor platform names and treats everything else as web", () => {
    expect(detectKind("ios")).toBe("ios");
    expect(detectKind("android")).toBe("android");
    expect(detectKind("web")).toBe("web");
    expect(detectKind(undefined)).toBe("web");
  });

  it("reports native only inside the Capacitor shell", () => {
    const web = createWebBridge(() => "web", () => "dyrakarmy.online", () => undefined);
    expect(web.info()).toEqual({ kind: "web", isNative: false, hostname: "dyrakarmy.online" });
    const ios = createWebBridge(() => "ios", () => "localhost", () => undefined);
    expect(ios.info().isNative).toBe(true);
    expect(ios.passkeyRpId()).toBe("localhost");
  });
});

describe("well-known files for native passkeys", () => {
  it("apple-app-site-association is valid JSON with a webcredentials app list", async () => {
    const fs = await import("node:fs");
    const json = JSON.parse(fs.readFileSync("public/.well-known/apple-app-site-association", "utf8"));
    expect(Array.isArray(json.webcredentials.apps)).toBe(true);
    expect(json.webcredentials.apps.length).toBeGreaterThan(0);
  });

  it("assetlinks.json is valid JSON with the login-creds relation", async () => {
    const fs = await import("node:fs");
    const json = JSON.parse(fs.readFileSync("public/.well-known/assetlinks.json", "utf8"));
    expect(json[0].relation).toContain("delegate_permission/common.get_login_creds");
    expect(json[0].target.namespace).toBe("android_app");
  });
});
