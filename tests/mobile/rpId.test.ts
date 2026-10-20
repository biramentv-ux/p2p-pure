import { describe, expect, it } from "vitest";
import { createWebBridge } from "../../src/platform/mobile/webBridge";

const configured = () => "dyrakarmy.online";

describe("passkey rpId per platform", () => {
  it("web keeps the page host", () => {
    const b = createWebBridge(() => "web", () => "dyrakarmy.online", configured);
    expect(b.passkeyRpId()).toBe("dyrakarmy.online");
  });

  it("native uses the configured domain even though the WebView host is localhost", () => {
    for (const platform of ["android", "ios"]) {
      const b = createWebBridge(() => platform, () => "localhost", configured);
      expect(b.passkeyRpId()).toBe("dyrakarmy.online");
    }
  });

  it("native without a configured domain falls back to the host", () => {
    const b = createWebBridge(() => "android", () => "localhost", () => undefined);
    expect(b.passkeyRpId()).toBe("localhost");
  });

  it("web ignores a configured domain that does not fit the page", () => {
    const b = createWebBridge(() => "web", () => "example.com", configured);
    expect(b.passkeyRpId()).toBe("example.com");
  });
});
