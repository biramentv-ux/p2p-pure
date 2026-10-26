import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { parseSha256Sums, formatSha256Sums, summarizeBom, diffHashes } from "../../scripts/release/lib.mjs";

const h = (c: string) => c.repeat(64);

describe("SHA256SUMS", () => {
  it("formats sorted, LF-only, with a trailing newline", () => {
    const text = formatSha256Sums([
      { name: "b.json", hash: h("b") },
      { name: "a.json", hash: h("a") },
    ]);
    expect(text).toBe(`${h("a")}  a.json\n${h("b")}  b.json\n`);
  });

  it("round-trips through parse", () => {
    const entries = [{ name: "x.cdx.json", hash: h("1") }, { name: "y.cdx.json", hash: h("2") }];
    expect(parseSha256Sums(formatSha256Sums(entries))).toEqual(entries);
  });

  it("accepts binary-mode markers, CRLF, comments and uppercase hashes", () => {
    const text = `# comment\r\n${h("A")} *file.bin\r\n\r\n`;
    expect(parseSha256Sums(text)).toEqual([{ name: "file.bin", hash: h("a") }]);
  });

  it("rejects malformed lines and path traversal", () => {
    expect(() => parseSha256Sums("nothex  file")).toThrow(/line 1/);
    expect(() => parseSha256Sums(`${h("a")}  ../etc/passwd`)).toThrow(/unsafe/);
    expect(() => parseSha256Sums(`${h("a")}  dir/file`)).toThrow(/unsafe/);
  });

  it("rejects bad hashes and duplicate names when formatting", () => {
    expect(() => formatSha256Sums([{ name: "a", hash: "zz" }])).toThrow(/bad sha256/);
    expect(() => formatSha256Sums([{ name: "a", hash: h("a") }, { name: "a", hash: h("b") }])).toThrow(/duplicate/);
  });
});

describe("summarizeBom", () => {
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: { component: { name: "p2p-messenger" } },
    components: [{ name: "react" }, { name: "jsqr" }],
  };

  it("summarizes a valid BOM", () => {
    expect(summarizeBom(bom)).toEqual({ specVersion: "1.5", components: 2, root: "p2p-messenger" });
  });

  it("rejects wrong format, spec version and empty BOMs", () => {
    expect(() => summarizeBom(null)).toThrow(/JSON object/);
    expect(() => summarizeBom({ ...bom, bomFormat: "SPDX" })).toThrow(/CycloneDX/);
    expect(() => summarizeBom({ ...bom, specVersion: "x" })).toThrow(/specVersion/);
    expect(() => summarizeBom({ ...bom, components: [] })).toThrow(/at least 1/);
    expect(() => summarizeBom(bom, { minComponents: 5 })).toThrow(/at least 5/);
    expect(() => summarizeBom({ ...bom, components: [{}] })).toThrow(/without a name/);
  });
});

describe("diffHashes", () => {
  it("lists changed, added and removed names", () => {
    expect(diffHashes({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" })).toEqual(["b", "c", "d"]);
    expect(diffHashes({ a: "1" }, { a: "1" })).toEqual([]);
  });
});

describe("writeSums", () => {
  it("hashes files, skips the sums file and signature bundles", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // @ts-expect-error plain .mjs script without type declarations
    const { writeSums, SUMS_NAME } = await import("../../scripts/release/sums.mjs");
    const dir = mkdtempSync(join(tmpdir(), "sums-"));
    writeFileSync(join(dir, "b.cdx.json"), "b");
    writeFileSync(join(dir, "a.cdx.json"), "a");
    writeFileSync(join(dir, "x.sigstore.json"), "sig");
    expect(writeSums(dir)).toBe(2);
    expect(writeSums(dir)).toBe(2); // idempotent: its own output is not hashed
    const text = readFileSync(join(dir, SUMS_NAME), "utf8");
    expect(text).toBe(
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.cdx.json\n" +
      "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.cdx.json\n",
    );
  });
});

describe("summarizeBom required components", () => {
  const bom = { bomFormat: "CycloneDX", specVersion: "1.5", components: [{ name: "tauri" }, { name: "windows" }] };
  it("passes when all are present and names the missing ones otherwise", () => {
    expect(summarizeBom(bom, { required: ["tauri", "windows"] }).components).toBe(2);
    expect(() => summarizeBom(bom, { required: ["windows", "gtk", "tauri", "webkit2gtk"] }))
      .toThrow(/missing required components: gtk, webkit2gtk/);
  });
});
