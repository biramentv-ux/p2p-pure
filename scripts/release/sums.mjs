#!/usr/bin/env node
// Write SHA256SUMS-sbom.txt for every release file in a folder (sorted, LF, no paths).
//   node scripts/release/sums.mjs <dir>
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { formatSha256Sums, parseSha256Sums } from './lib.mjs'

export const SUMS_NAME = 'SHA256SUMS-sbom.txt' // distinct from the SHA256SUMS-linux.txt of the desktop workflows

export function writeSums(dir) {
  // Everything except the sums file itself and Sigstore signature bundles.
  const files = readdirSync(dir).filter((f) => f !== SUMS_NAME && !f.endsWith('.sigstore.json'))
  const entries = files.map((name) => ({
    name,
    hash: createHash('sha256').update(readFileSync(join(dir, name))).digest('hex'),
  }))
  const text = formatSha256Sums(entries)
  parseSha256Sums(text) // self-check
  rmSync(join(dir, SUMS_NAME), { force: true })
  writeFileSync(join(dir, SUMS_NAME), text)
  return entries.length
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = resolve(process.argv[2] ?? '')
  if (!process.argv[2]) { console.error('usage: sums.mjs <dir>'); process.exit(2) }
  console.log(`${SUMS_NAME}: ${writeSums(dir)} files`)
}
