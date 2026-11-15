import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../src/p2p/protocol";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("protocol documentation (Н10)", () => {
  it("names the current protocol version", () => {
    expect(read("docs/PROTOCOL.md")).toContain(`Версия на протокола: **${PROTOCOL_VERSION}**`);
  });

  it("documents every frame prefix the code uses", () => {
    const letters = new Set<string>();
    for (const f of sources(join(root, "src"))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:FRAME_MARK\}|FRAME_MARK \+ ")([A-Z])\|/g)) letters.add(m[1]);
      for (const m of text.matchAll(/\["F\|", "A\|", "X\|", "R\|", "W\|"\]/g)) for (const l of "FAXRW") letters.add(l);
    }
    const doc = read("docs/PROTOCOL.md");
    for (const l of letters) expect(doc, `prefix ${l}|`).toMatch(new RegExp(`\\\\u0001${l}\\\\?\\||/ \`?${l}\\\\?\\|`));
  });

  it("security.txt follows RFC 9116 and has not expired", () => {
    const txt = read("public/.well-known/security.txt");
    expect(txt).toMatch(/^Contact: https:\/\//m);
    const exp = /^Expires: (.+)$/m.exec(txt)?.[1];
    expect(exp).toBeTruthy();
    const t = Date.parse(exp!);
    expect(t).toBeGreaterThan(Date.now());
    // RFC 9116 recommends less than a year ahead: renew it with each yearly release.
    expect(t - Date.now()).toBeLessThan(400 * 24 * 3600 * 1000);
    expect(read("SECURITY.md")).toContain("90 days");
    expect(read("SECURITY.bg.md")).toContain("90 дни");
  });

  it("the threat model lists what it does not protect against", () => {
    const tm = read("docs/THREAT_MODEL.md");
    expect(tm).toContain("От какво НЕ пазим");
    for (const s of ["Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", "Elevation"]) {
      expect(tm.replace(/\*\*/g, "")).toContain(s);
    }
  });
});

describe("the Н10 documents reach the public repository", () => {
  it("public-docs.yml copies the protocol, the threat model and device protection", () => {
    const wf = read(".github/workflows/public-docs.yml");
    for (const f of ["PROTOCOL.md", "THREAT_MODEL.md", "SECURITY-DEVICE.md"]) {
      expect(wf).toContain(`- docs/${f}`);
      expect(wf).toContain(`src/docs/${f}`);
    }
  });
});
