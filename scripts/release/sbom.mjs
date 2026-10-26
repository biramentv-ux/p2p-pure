#!/usr/bin/env node
// Generate CycloneDX SBOMs (JSON) for every shipped component and a SHA256SUMS file.
//
//   node scripts/release/sbom.mjs [--out dist-release] [--only web,electron,rust] [--root <checkout>] [--version <tag>] [--sums]
//
// web      npm production dependencies of the root package (what ends up in the bundle)
// electron every dependency of electron/ (runtime + builder), from its lockfile
// rust     the src-tauri crate (cargo-cyclonedx), from Cargo.lock
//
// The generators are pinned to exact versions. Output is made reproducible (no timestamp or
// random serial), so the same lockfiles give byte-identical SBOMs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeBom } from './lib.mjs'
import { SUMS_NAME, writeSums } from './sums.mjs'

export const CYCLONEDX_NPM = '6.0.1' // @cyclonedx/cyclonedx-npm
export const CYCLONEDX_CARGO = '0.5.9' // cargo-cyclonedx
export const SPEC_VERSION = '1.5'


function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

// --root: the checkout whose lockfiles are described (default: this repository). CI uses it
// to run the trusted scripts of one ref against the tree of a release tag.
const root = resolve(arg('root', resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], cwd: root, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`)
}

function npmBom(manifest, outFile, extra) {
  run('npm', [
    'exec', '--yes', `--package=@cyclonedx/cyclonedx-npm@${CYCLONEDX_NPM}`, '--',
    'cyclonedx-npm', manifest,
    '--package-lock-only', '--output-reproducible', '--validate',
    '--spec-version', SPEC_VERSION, '--output-format', 'JSON', '--output-file', outFile,
    ...extra,
  ])
}

const generators = {
  web: (out) => npmBom('package.json', out, ['--omit', 'dev']),
  electron: (out) => npmBom('electron/package.json', out, []),
  rust: (out) => {
    const ver = spawnSync('cargo', ['cyclonedx', '--version'], { encoding: 'utf8' })
    if (ver.status !== 0) throw new Error(`cargo-cyclonedx missing: cargo install cargo-cyclonedx --version ${CYCLONEDX_CARGO} --locked`)
    if (!ver.stdout.includes(CYCLONEDX_CARGO)) console.warn(`warning: expected cargo-cyclonedx ${CYCLONEDX_CARGO}, got ${ver.stdout.trim()}`)
    run('cargo', [
      'cyclonedx', '--manifest-path', 'src-tauri/Cargo.toml', '--format', 'json',
      '--spec-version', SPEC_VERSION, '--override-filename', 'p2p-pure-tauri.cdx',
    ])
    // cargo-cyclonedx writes next to the manifest; move it out of the source tree.
    renameSync(join(root, 'src-tauri', 'p2p-pure-tauri.cdx.json'), out)
  },
}

const outDir = resolve(arg('out', 'release-sbom'))
const version = arg('version', 'dev')
const only = arg('only', 'web,electron,rust').split(',').filter(Boolean)
const minComponents = { web: 20, electron: 100, rust: 100 }

mkdirSync(outDir, { recursive: true })
const produced = []
for (const name of only) {
  if (!generators[name]) throw new Error(`unknown target "${name}"`)
  const file = `p2p-pure-${version}-${name}.cdx.json`
  const path = join(outDir, file)
  console.log(`== ${name} -> ${file}`)
  generators[name](path)
  const s = summarizeBom(JSON.parse(readFileSync(path, 'utf8')), { minComponents: minComponents[name] })
  console.log(`   CycloneDX ${s.specVersion}, ${s.components} components`)
  produced.push(file)
}

if (flag('sums')) console.log(`== ${SUMS_NAME}: ${writeSums(outDir)} files`)
