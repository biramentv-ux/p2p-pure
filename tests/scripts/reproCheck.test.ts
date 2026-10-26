import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Runs the real script with its fake-build hook (no npm), so the comparison logic is tested.
const script = join(__dirname, "../../scripts/release/repro-check.sh");
const run = (env: Record<string, string>) =>
  spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, REPRO_FAKE_BUILD: "1", ...env } });

describe.skipIf(process.platform === "win32")("repro-check.sh", () => {
  it("exits 0 and removes the trees when the builds match", () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("byte-identical");
    expect(r.stdout).not.toContain("kept:");
  }, 60_000);

  it("exits 1, lists the differing file and keeps both trees when they differ", () => {
    const r = run({ REPRO_INJECT_DIFF: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("./assets/app.js");
    expect(r.stderr).not.toContain("./index.html");
    const kept = /kept: (\S+)/.exec(r.stdout + r.stderr)?.[1];
    expect(kept).toBeTruthy();
    expect(readFileSync(join(kept!, "build2/dist/assets/app.js"), "utf8")).toBe("changed\n");
    expect(existsSync(join(kept!, "build1/dist/assets/app.js"))).toBe(true);
    spawnSync("rm", ["-rf", kept!]);
  }, 60_000);
});
