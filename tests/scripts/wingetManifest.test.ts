import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { buildManifests, PACKAGE_ID, MANIFEST_VERSION } from "../../scripts/windows/winget-manifest.mjs";

const ok = {
  version: "0.7.0",
  url: "https://github.com/biramentv-ux/p2p-pure/releases/download/desktop-v0.7.0/P2P-Messenger-Setup-x64.exe",
  sha256: "ab".repeat(32),
};

describe("winget manifests", () => {
  it("writes the four files in the winget-pkgs layout", () => {
    const { relativeDir, files } = buildManifests(ok);
    expect(relativeDir.replace(/\\/g, "/")).toBe("manifests/d/DyrakArmy/P2PMessenger/0.7.0");
    expect(Object.keys(files).sort()).toEqual([
      `${PACKAGE_ID}.installer.yaml`,
      `${PACKAGE_ID}.locale.bg-BG.yaml`,
      `${PACKAGE_ID}.locale.en-US.yaml`,
      `${PACKAGE_ID}.yaml`,
    ]);
  });

  it("describes a per-user NSIS installer with the given url and an uppercase hash", () => {
    const installer = buildManifests(ok).files[`${PACKAGE_ID}.installer.yaml`];
    expect(installer).toContain('InstallerType: "nullsoft"');
    expect(installer).toContain('Scope: "user"');
    expect(installer).toContain(`InstallerUrl: "${ok.url}"`);
    expect(installer).toContain(`InstallerSha256: "${"AB".repeat(32)}"`);
    expect(installer).toContain(`ManifestVersion: "${MANIFEST_VERSION}"`);
  });

  it("every file carries the same identifier and version", () => {
    for (const content of Object.values(buildManifests(ok).files) as string[]) {
      expect(content).toContain(`PackageIdentifier: "${PACKAGE_ID}"`);
      expect(content).toContain('PackageVersion: "0.7.0"');
    }
  });

  it("refuses a bad version, a non-https url, or a short hash", () => {
    expect(() => buildManifests({ ...ok, version: "v0.7" })).toThrow("version");
    expect(() => buildManifests({ ...ok, url: "http://example.com/a.exe" })).toThrow("url");
    expect(() => buildManifests({ ...ok, sha256: "abc" })).toThrow("sha256");
  });
});
