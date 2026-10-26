#!/usr/bin/env node
/**
 * Writes the winget manifests (schema 1.10.0) for one release of the Windows installer.
 * No dependencies. Used by .github/workflows/windows-desktop.yml; can also be run by hand:
 *
 *   node scripts/windows/winget-manifest.mjs --version 0.7.0 \
 *     --url https://github.com/biramentv-ux/p2p-pure/releases/download/desktop-v0.7.0/P2P-Messenger-Setup-x64.exe \
 *     --sha256 <64 hex> --out out/winget
 *
 * Output: <out>/manifests/d/DyrakArmy/P2PMessenger/<version>/ with the version, installer,
 * en-US (default) and bg-BG locale files, the layout microsoft/winget-pkgs expects.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_ID = "DyrakArmy.P2PMessenger";
// 1.10.0, not the newest 1.12.0: winget 1.11 (still common, and on the CI runner) cannot read 1.12 manifests.
export const MANIFEST_VERSION = "1.10.0";
const REPO = "https://github.com/biramentv-ux/p2p-pure";

/** Every scalar is written as a JSON string, which is valid YAML and needs no escaping rules. */
const q = (v) => JSON.stringify(String(v));

function header(kind) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${MANIFEST_VERSION}.schema.json\n`;
}

export function validateInput({ version, url, sha256 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error(`version must look like 1.2.3, got "${version}"`);
  if (!/^https:\/\/\S+\.exe$/.test(url ?? "")) throw new Error(`url must be an https link to the .exe, got "${url}"`);
  if (!/^[0-9a-fA-F]{64}$/.test(sha256 ?? "")) throw new Error("sha256 must be 64 hex characters");
}

/** Returns { relativeDir, files: { name: content } } without touching the disk. */
export function buildManifests({ version, url, sha256 }) {
  validateInput({ version, url, sha256 });
  const id = PACKAGE_ID;
  const common = `PackageIdentifier: ${q(id)}\nPackageVersion: ${q(version)}\n`;

  const versionFile =
    header("version") +
    common +
    `DefaultLocale: "en-US"\nManifestType: "version"\nManifestVersion: ${q(MANIFEST_VERSION)}\n`;

  const installerFile =
    header("installer") +
    common +
    `InstallerType: "nullsoft"\n` +
    `Scope: "user"\n` +
    `InstallModes:\n  - "interactive"\n  - "silent"\n  - "silentWithProgress"\n` +
    `UpgradeBehavior: "install"\n` +
    `Installers:\n` +
    `  - Architecture: "x64"\n` +
    `    InstallerUrl: ${q(url)}\n` +
    `    InstallerSha256: ${q(sha256.toUpperCase())}\n` +
    `ManifestType: "installer"\nManifestVersion: ${q(MANIFEST_VERSION)}\n`;

  const enFile =
    header("defaultLocale") +
    common +
    `PackageLocale: "en-US"\n` +
    `Publisher: "DyrakArmy"\n` +
    `PublisherUrl: ${q("https://github.com/biramentv-ux")}\n` +
    `PackageName: "P2P Messenger"\n` +
    `PackageUrl: ${q(REPO)}\n` +
    `License: "MIT"\n` +
    `LicenseUrl: ${q(`${REPO}/blob/main/LICENSE`)}\n` +
    `ShortDescription: "End-to-end encrypted peer-to-peer messenger with no account and no phone number."\n` +
    `Description: ${q(
      "Messages, photos and calls go directly between devices over WebRTC, encrypted end to end. Identity is a passkey or a 12-word recovery phrase; there is no sign-up, email or SMS. History is stored encrypted on the device.",
    )}\n` +
    `Moniker: "p2p-messenger"\n` +
    `Tags:\n  - "messenger"\n  - "p2p"\n  - "encryption"\n  - "webrtc"\n  - "privacy"\n` +
    `ReleaseNotesUrl: ${q(`${REPO}/releases/tag/desktop-v${version}`)}\n` +
    `ManifestType: "defaultLocale"\nManifestVersion: ${q(MANIFEST_VERSION)}\n`;

  const bgFile =
    header("locale") +
    common +
    `PackageLocale: "bg-BG"\n` +
    `Publisher: "DyrakArmy"\n` +
    `PackageName: "P2P Messenger"\n` +
    `ShortDescription: "Шифрован месинджър между устройства, без регистрация и без телефонен номер."\n` +
    `Description: ${q(
      "Съобщенията, снимките и разговорите минават директно между устройствата през WebRTC, шифровани от край до край. Идентичността е passkey или 12 думи за възстановяване; няма регистрация, имейл или SMS. Историята се пази шифрована на устройството.",
    )}\n` +
    `ManifestType: "locale"\nManifestVersion: ${q(MANIFEST_VERSION)}\n`;

  return {
    relativeDir: join("manifests", "d", "DyrakArmy", "P2PMessenger", version),
    files: {
      [`${id}.yaml`]: versionFile,
      [`${id}.installer.yaml`]: installerFile,
      [`${id}.locale.en-US.yaml`]: enFile,
      [`${id}.locale.bg-BG.yaml`]: bgFile,
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("winget-manifest.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  const { relativeDir, files } = buildManifests(args);
  const dir = join(args.out ?? "out/winget", relativeDir);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  console.log(dir);
}
