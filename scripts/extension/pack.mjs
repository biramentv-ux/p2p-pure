/**
 * Packs extension/ into a store-ready zip: dist/extension/p2p-messenger-quick-launch-<version>.zip
 *
 *   npm run extension:pack
 *
 * No dependencies: a small zip writer (deflate + CRC-32). Only files under extension/
 * are included, so the repo's tests, docs and secrets never end up in the package.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The same extension is also published by the site build (scripts/site/build.mjs). */
export const EXTENSION_SRC = join(ROOT, "extension");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * DOS date/time stored in the zip. Fixed at 1980-01-01 00:00, so the same files always give the same
 * bytes (and the same SHA-256) no matter when or where the package is made.
 */
function dosStamp() {
  return { time: 0, day: (0 << 9) | (1 << 5) | 1 };
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosStamp();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.concat([local, nameBuf, packed]);
    locals.push(record);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += record.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * Packs the extension folder. Deterministic: sorted names, fixed timestamps, no local state.
 * Returns the file name, the bytes, and what the site shows next to the download button.
 */
export function packExtension({ src = EXTENSION_SRC } = {}) {
  const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
  const entries = walk(src).sort().map((path) => ({
    // Zip paths always use forward slashes.
    name: relative(src, path).split(sep).join("/"),
    data: readFileSync(path),
  }));
  const zip = buildZip(entries);
  return {
    version: manifest.version,
    file: `p2p-messenger-quick-launch-${manifest.version}.zip`,
    zip,
    size: zip.length,
    sha256: createHash("sha256").update(zip).digest("hex"),
    entries: entries.map((e) => e.name),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outDir = resolve("dist", "extension");
  const pkg = packExtension();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, pkg.file), pkg.zip);
  console.log(`Packed ${pkg.entries.length} files into ${join(outDir, pkg.file)}`);
  for (const name of pkg.entries) console.log(`  ${name}`);
}
