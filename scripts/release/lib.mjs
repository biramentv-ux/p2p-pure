// Pure helpers for the release scripts (SBOM + SHA256SUMS). No I/O, so they are unit-tested.

/** Parse a `sha256sum`-style file. Accepts text ("  ") and binary ("*") mode markers. */
export function parseSha256Sums(text) {
  const out = []
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
    if (!m) throw new Error(`SHA256SUMS: line ${i + 1} is not "<sha256>  <name>"`)
    const name = m[2]
    if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
      throw new Error(`SHA256SUMS: line ${i + 1}: unsafe file name "${name}"`)
    }
    out.push({ hash: m[1].toLowerCase(), name })
  }
  return out
}

/** Deterministic SHA256SUMS text: sorted by name (byte order), LF only, trailing newline. */
export function formatSha256Sums(entries) {
  const seen = new Set()
  for (const e of entries) {
    if (!/^[0-9a-f]{64}$/.test(e.hash)) throw new Error(`bad sha256 for ${e.name}`)
    if (seen.has(e.name)) throw new Error(`duplicate file name ${e.name}`)
    seen.add(e.name)
  }
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.hash}  ${e.name}\n`)
    .join('')
}

/**
 * Check that a parsed JSON document is a usable CycloneDX BOM and return a short summary.
 * Throws with a readable message otherwise, so the release fails before signing junk.
 */
export function summarizeBom(bom, { minComponents = 1 } = {}) {
  if (!bom || typeof bom !== 'object') throw new Error('BOM is not a JSON object')
  if (bom.bomFormat !== 'CycloneDX') throw new Error(`bomFormat is "${bom.bomFormat}", expected CycloneDX`)
  if (typeof bom.specVersion !== 'string' || !/^1\.\d+$/.test(bom.specVersion)) {
    throw new Error(`bad specVersion "${bom.specVersion}"`)
  }
  const components = Array.isArray(bom.components) ? bom.components : []
  if (components.length < minComponents) {
    throw new Error(`BOM has ${components.length} components, expected at least ${minComponents}`)
  }
  for (const c of components) {
    if (!c || typeof c.name !== 'string' || !c.name) throw new Error('component without a name')
  }
  return {
    specVersion: bom.specVersion,
    components: components.length,
    root: bom.metadata?.component?.name ?? null,
  }
}

/** Compare two {name -> hash} maps; returns the list of differing names. */
export function diffHashes(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...names].filter((n) => a[n] !== b[n]).sort()
}
