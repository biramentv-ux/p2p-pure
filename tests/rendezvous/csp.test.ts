import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RELAYS } from "../../src/rendezvous/relayPool";

describe("CSP lists exactly the rendezvous relays", () => {
  it("every default relay is in connect-src, and wss: is not opened wide", () => {
    const cfg = readFileSync(join(__dirname, "../../vite.config.ts"), "utf8");
    const line = /let nostrRelays = '([^']+)'/.exec(cfg)?.[1] ?? "";
    expect(line.split(" ").sort()).toEqual([...DEFAULT_RELAYS].sort());
    expect(cfg).not.toMatch(/connect-src[^`]*\swss:\s/);
  });
});
