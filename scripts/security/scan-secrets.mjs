/**
 * Fails when a tracked file contains something that looks like a live credential.
 * Written after the 2026-10 tunnel-token incident (docs/incidents/): a token pasted into
 * a chat or a file is the most likely leak, so the check looks for the token shapes we use.
 *
 *   node scripts/security/scan-secrets.mjs
 *
 * No dependencies. Scans only files git tracks; package-lock.json is skipped because its
 * integrity hashes look like random strings.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "Cloudflare Tunnel install token", re: /cloudflared\b[^\n]*\bservice\s+install\s+(?!<)[A-Za-z0-9_-]{60,}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "Cloudflare API token", re: /\bcfut_[A-Za-z0-9_-]{30,}/ },
];

const SKIP = new Set(["package-lock.json"]);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !SKIP.has(f));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted or unreadable in the working tree
  }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}  ${name}`);
    }
  });
}

if (findings.length) {
  console.error("Possible secrets found in tracked files:");
  for (const f of findings) console.error("  " + f);
  console.error("Remove the value, rotate it at the provider, and use a placeholder such as <ТОКЕН>.");
  process.exit(1);
}
console.log(`Secret scan clean: ${files.length} tracked files checked.`);
