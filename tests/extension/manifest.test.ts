import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "extension");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const manifest = JSON.parse(read("manifest.json"));

/** Width and height from the PNG IHDR chunk. */
function pngSize(rel: string): { width: number; height: number } {
  const buf = readFileSync(join(ROOT, rel));
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function messageKeys(locale: string): Set<string> {
  return new Set(Object.keys(JSON.parse(read(`_locales/${locale}/messages.json`))));
}

describe("manifest", () => {
  it("is Manifest V3 with the expected default locale", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.default_locale).toBe("en");
  });

  it("references only files that exist", () => {
    const referenced = [
      manifest.action.default_popup,
      manifest.background.service_worker,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const rel of referenced) {
      expect(existsSync(join(ROOT, rel)), `missing ${rel}`).toBe(true);
    }
  });

  it("declares icons with the pixel size their key says", () => {
    for (const [size, rel] of Object.entries(manifest.icons as Record<string, string>)) {
      expect(pngSize(rel)).toEqual({ width: Number(size), height: Number(size) });
    }
  });

  it("has an action key, which chrome.action needs", () => {
    expect(manifest.action).toBeTruthy();
  });

  it("asks only for the messenger host, with no broad permissions", () => {
    expect(manifest.permissions ?? []).toEqual([]);
    expect(manifest.host_permissions).toEqual(["https://dyrakarmy.online/*"]);
  });

  it("has a shortcut with a default and a Mac key", () => {
    const cmd = manifest.commands["open-messenger"];
    expect(cmd.suggested_key.default).toBeTruthy();
    expect(cmd.suggested_key.mac).toBeTruthy();
  });

  it("uses only messages that exist in both English and Bulgarian", () => {
    const used = new Set<string>();
    for (const value of [manifest.name, manifest.description, manifest.action.default_title, manifest.commands["open-messenger"].description]) {
      const m = /^__MSG_(\w+)__$/.exec(value);
      if (m) used.add(m[1]);
    }
    const popupKeys = [...read("popup.html").matchAll(/data-i18n="(\w+)"/g)].map((m) => m[1]);
    for (const key of popupKeys) used.add(key);
    const en = messageKeys("en");
    const bg = messageKeys("bg");
    for (const key of used) {
      expect(en.has(key), `en is missing ${key}`).toBe(true);
      expect(bg.has(key), `bg is missing ${key}`).toBe(true);
    }
    expect(bg).toEqual(en);
  });
});

describe("extension code", () => {
  const files = ["launch.js", "service-worker.js", "popup.js"];

  it("contains no eval, Function constructor or inline script", () => {
    for (const file of files) {
      const src = read(file);
      expect(/\beval\s*\(|new Function\s*\(/.test(src), file).toBe(false);
    }
    const html = read("popup.html");
    expect(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "inline <script>").toBe(false);
    expect(/\son[a-z]+\s*=/i.test(html), "inline event handler").toBe(false);
  });

  it("never chains .then() on chrome.* calls", () => {
    for (const file of files) {
      expect(/\.then\s*\(/.test(read(file)), file).toBe(false);
    }
  });
});
