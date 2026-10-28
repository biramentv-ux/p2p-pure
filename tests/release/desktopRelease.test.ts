// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const script = join(root, "scripts/release/desktop-release.sh");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// A fake `gh` that keeps one release in a folder: draft or published, and its file names.
const FAKE_GH = `#!/usr/bin/env bash
S="$FAKE_STATE"
args="$*"
case "$1 $2" in
  "api -X")
    rm -f "$S/tag" "$S/draft" "$S/assets" "$S/body"; echo deleted >> "$S/log"; exit 0 ;;
  "api repos/o/r/releases"|"api repos/o/pub/releases")
    tag="$(printf '%s' "$args" | sed -n 's/.*tag_name == "\\([^"]*\\)".*/\\1/p')"
    [ -f "$S/tag" ] && [ "$(cat "$S/tag")" = "$tag" ] && echo "7 $(cat "$S/draft")"
    exit 0 ;;
  "api repos/o/r/releases/7"|"api repos/o/pub/releases/7")
    case "$args" in *.body*) cat "$S/body" 2>/dev/null ;; *) cat "$S/assets" 2>/dev/null ;; esac; exit 0 ;;
  "release create")
    echo "$3" > "$S/tag"; echo true > "$S/draft"; : > "$S/assets"; echo created >> "$S/log"; echo "$args" > "$S/create-args"
    nf="$(printf '%s' "$args" | sed -n 's/.*--notes-file \\([^ ]*\\).*/\\1/p')"; cp "$nf" "$S/body"; exit 0 ;;
  "release upload")
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in --repo) echo "$2" > "$S/repo"; shift 2 ;; --*) shift ;; *) basename "$1" >> "$S/assets"; shift ;; esac
    done
    sort -u "$S/assets" -o "$S/assets"; echo upload >> "$S/log"; exit 0 ;;
  "release edit") echo false > "$S/draft"; echo published >> "$S/log"; exit 0 ;;
esac
echo "unexpected gh $args" >&2; exit 9
`;

describe("desktop release script (draft -> upload -> publish)", () => {
  let dir: string;
  let state: string;
  let env: NodeJS.ProcessEnv;

  const files = (name: string, names: string[]) => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    for (const n of names) writeFileSync(join(d, n), "x");
    return d;
  };
  const run = (...a: string[]) => spawnSync("bash", [script, ...a], { env, encoding: "utf8" });
  const out = () => join(state, "out");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relscript-"));
    state = join(dir, "state");
    mkdirSync(state);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(join(dir, "notes.md"), "notes");
    env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATE: state,
      GITHUB_REPOSITORY: "o/r",
      RELEASES_REPO: "", // CI workflows export it; the tests choose their own
      GH_TOKEN: "x",
      GITHUB_OUTPUT: out(),
      WAIT_SLEEP: "0",
    };
  });

  it("keeps a draft until Windows, Linux and the SBOM have added their files, then publishes once", () => {
    const win = files("win", ["P2P-Messenger-Setup-x64.exe", "SHA256SUMS.txt"]);
    const lin = files("lin", ["P2P-Messenger-0.7.0-amd64.deb", "SHA256SUMS-linux.txt"]);
    const sbom = files("sbom", ["web.cdx.json", "SHA256SUMS-sbom.txt"]);

    for (const d of [win, lin]) {
      const r = run("attach", "desktop-v0.7.0", d, "abc", join(dir, "notes.md"));
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(readFileSync(join(state, "draft"), "utf8").trim()).toBe("true");
      expect(readFileSync(out(), "utf8")).toContain("published=false");
    }

    const r = run("attach", "desktop-v0.7.0", sbom, "abc", join(dir, "notes.md"));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(join(state, "draft"), "utf8").trim()).toBe("false");
    expect(readFileSync(out(), "utf8")).toContain("published=true");
    const log = readFileSync(join(state, "log"), "utf8").trim().split("\n");
    expect(log.filter((l) => l === "created")).toHaveLength(1);
    expect(log.filter((l) => l === "published")).toHaveLength(1);
  });

  it("with RELEASES_REPO, works on that repository and sets no target commit (it is not in that repository)", () => {
    env = { ...env, RELEASES_REPO: "o/pub" };
    const win = files("win", ["P2P-Messenger-Setup-x64.exe"]);
    const lin = files("lin", ["SHA256SUMS-linux.txt"]);
    const sbom = files("sbom", ["SHA256SUMS-sbom.txt"]);
    for (const d of [win, lin, sbom]) {
      const r = run("attach", "desktop-v0.7.0", d, "abc123", join(dir, "notes.md"));
      expect(r.status, r.stderr + r.stdout).toBe(0);
    }
    expect(readFileSync(join(state, "draft"), "utf8").trim()).toBe("false");
    expect(readFileSync(join(state, "repo"), "utf8").trim()).toBe("o/pub");
    const created = readFileSync(join(state, "create-args"), "utf8");
    expect(created).toContain("--repo o/pub");
    expect(created).not.toContain("--target");
  });

  it("without RELEASES_REPO the release is created on the built commit, as before", () => {
    const r = run("attach", "desktop-v0.7.0", files("win", ["P2P-Messenger-Setup-x64.exe"]), "abc123", join(dir, "notes.md"));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(join(state, "create-args"), "utf8")).toContain("--target abc123");
  });

  it("records the source commit in the draft notes", () => {
    const r = run("attach", "desktop-v0.7.0", files("win", ["P2P-Messenger-Setup-x64.exe"]), "abc123", join(dir, "notes.md"));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const body = readFileSync(join(state, "body"), "utf8");
    expect(body).toContain("notes");
    expect(body).toContain("<!-- source-commit: abc123 -->");
  });

  it("deletes a stale draft from another commit instead of publishing with its old files", () => {
    // an earlier failed run of the same tag left a draft that already has the Linux files
    writeFileSync(join(state, "tag"), "desktop-v0.7.0");
    writeFileSync(join(state, "draft"), "true");
    writeFileSync(join(state, "assets"), "SHA256SUMS-linux.txt\n");
    writeFileSync(join(state, "body"), "notes\n<!-- source-commit: 0ld0ld -->\n");
    const r = run("attach", "desktop-v0.7.0", files("win", ["P2P-Messenger-Setup-x64.exe"]), "abc123", join(dir, "notes.md"));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/stale draft/);
    expect(readFileSync(join(state, "draft"), "utf8").trim()).toBe("true");
    expect(readFileSync(join(state, "assets"), "utf8")).not.toContain("SHA256SUMS-linux.txt");
    expect(readFileSync(out(), "utf8")).toContain("published=false");
    expect(readFileSync(join(state, "log"), "utf8").trim().split("\n")).toEqual(["deleted", "created", "upload"]);
  });

  it("a draft without the commit marker (older script) also counts as stale", () => {
    writeFileSync(join(state, "tag"), "desktop-v0.7.0");
    writeFileSync(join(state, "draft"), "true");
    writeFileSync(join(state, "assets"), "SHA256SUMS-linux.txt\n");
    writeFileSync(join(state, "body"), "notes\n");
    const r = run("attach", "desktop-v0.7.0", files("win", ["P2P-Messenger-Setup-x64.exe"]), "abc123", join(dir, "notes.md"));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(readFileSync(join(state, "draft"), "utf8").trim()).toBe("true");
  });

  it("refuses to add files to a release that is already published (immutable)", () => {
    writeFileSync(join(state, "tag"), "desktop-v0.7.0");
    writeFileSync(join(state, "draft"), "false");
    const r = run("attach", "desktop-v0.7.0", files("win", ["P2P-Messenger-Setup-x64.exe"]), "abc", join(dir, "notes.md"));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/immutable/);
    expect(existsSync(join(state, "log"))).toBe(false);
  });

  it("rejects a tag that is not a desktop tag", () => {
    const r = run("attach", "android-v1", files("win", ["a"]), "abc", join(dir, "notes.md"));
    expect(r.status).toBe(1);
  });

  it("wait succeeds once published and fails when it never is", () => {
    writeFileSync(join(state, "tag"), "desktop-v0.7.0");
    writeFileSync(join(state, "draft"), "true");
    expect(run("wait", "desktop-v0.7.0", "0").status).toBe(1);
    writeFileSync(join(state, "draft"), "false");
    expect(run("wait", "desktop-v0.7.0", "1").status).toBe(0);
  });
});

describe("desktop workflows", () => {
  const win = read(".github/workflows/windows-desktop.yml");
  const lin = read(".github/workflows/linux-desktop.yml");

  it("pin every action and grant write access only to the jobs that attach files", () => {
    for (const wf of [win, lin]) {
      for (const line of wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line, line).toMatch(/@[0-9a-f]{40}\b/);
      expect(wf.match(/^permissions:\r?\n  contents: read/m)).not.toBeNull();
      expect(wf.match(/contents: write/g)?.length).toBe(1);
    }
  });

  it("the SBOM goes into the same draft on the tag push, in the same serialising group", () => {
    const sbom = read(".github/workflows/release-sbom.yml");
    expect(sbom).toMatch(/push:\r?\n\s+tags: \['desktop-v\*'\]/);
    expect(sbom).toMatch(/desktop-release\.sh attach "\$TAG" release-sbom "\$COMMIT"/);
    expect(sbom).toContain("group: desktop-release-${{ github.event.release.tag_name || inputs.tag || github.ref_name }}");
    expect(read("scripts/release/desktop-release.sh")).toMatch(/SHA256SUMS-sbom\.txt/);
  });

  it("a hanging winget install cannot use up the whole verify job", () => {
    const step = win.slice(win.indexOf("- name: Install with winget from the release"));
    expect(step.split("run:")[0]).toMatch(/timeout-minutes: \d+/);
    expect(step).toContain("WaitForExit(");
  });

  it("both go through the draft script and share one serialising group", () => {
    for (const wf of [win, lin]) {
      expect(wf).toMatch(/desktop-release\.sh attach/);
      expect(wf).toMatch(/desktop-release\.sh wait/);
      expect(wf).toMatch(/group: desktop-release-\$\{\{ inputs\.release_tag \|\| github\.ref_name \}\}/);
      expect(wf).not.toMatch(/gh release create/);
    }
  });

  it("run the checks that need public downloads only after the release is published", () => {
    const winVerify = win.slice(win.indexOf("release-verify:"));
    expect(winVerify.indexOf("desktop-release.sh wait")).toBeLessThan(winVerify.indexOf('"install", "--manifest"'));
    const linVerify = lin.slice(lin.indexOf("release-verify:"));
    expect(linVerify.indexOf("desktop-release.sh wait")).toBeLessThan(linVerify.indexOf("install.sh --version"));
  });

  it("the script waits for the same files the workflows produce", () => {
    const sh = read("scripts/release/desktop-release.sh");
    expect(sh).toMatch(/P2P-Messenger-Setup-x64\.exe/);
    expect(sh).toMatch(/SHA256SUMS-linux\.txt/);
    expect(win).toMatch(/P2P-Messenger-Setup-x64\.exe/);
    expect(lin).toMatch(/SHA256SUMS-linux\.txt/);
  });
});
