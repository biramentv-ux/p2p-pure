/**
 * Error correction and integrity helpers for the audio modem (M7).
 *
 * - Reed–Solomon over GF(256) (primitive polynomial 0x11d, first consecutive root α^0),
 *   systematic, shortened codes of any length n ≤ 255. Errors-only decoding
 *   (Berlekamp–Massey + Chien search + Forney): corrects up to ⌊nsym/2⌋ wrong bytes per
 *   codeword and returns `null` when a codeword cannot be corrected with certainty.
 * - Block plan + byte interleaving: the body is split into near-equal blocks of at most
 *   {@link RS_BLOCK_DATA} bytes, each with {@link RS_BLOCK_PARITY} parity bytes, and the
 *   codewords are interleaved byte by byte so a burst of bad symbols (a cough, a door)
 *   is spread across every block instead of exhausting one.
 * - CRC-32 (IEEE 802.3, reflected, init/xorout 0xffffffff).
 *
 * Pure functions, no allocation beyond the returned arrays, no dependencies.
 */

// ---------------------------------------------------------------------------
// GF(256)
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new RangeError('GF(256) division by zero')
  if (a === 0) return 0
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255]
}

/** α^e for any integer e (negative allowed). */
export function gfPow(e: number): number {
  return GF_EXP[((e % 255) + 255) % 255]
}

const generatorCache = new Map<number, Uint8Array>()

/** Generator polynomial ∏(x − α^i), i = 0..nsym−1, highest degree first. */
export function rsGenerator(nsym: number): Uint8Array {
  const cached = generatorCache.get(nsym)
  if (cached) return cached
  let g = new Uint8Array([1])
  for (let i = 0; i < nsym; i++) {
    const next = new Uint8Array(g.length + 1)
    const root = gfPow(i)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= gfMul(g[j], root)
    }
    g = next
  }
  generatorCache.set(nsym, g)
  return g
}

/** Systematic RS encode: returns `data ‖ parity` (length data.length + nsym ≤ 255). */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (nsym < 1 || data.length + nsym > 255) throw new RangeError('RS codeword too long')
  const g = rsGenerator(nsym)
  const out = new Uint8Array(data.length + nsym)
  out.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = out[i]
    if (coef === 0) continue
    for (let j = 1; j < g.length; j++) out[i + j] ^= gfMul(g[j], coef)
  }
  out.set(data) // the division overwrote the message part
  return out
}

function syndromes(cw: Uint8Array, nsym: number, out: Uint8Array): boolean {
  let nonZero = false
  for (let m = 0; m < nsym; m++) {
    const x = gfPow(m)
    let acc = 0
    for (let i = 0; i < cw.length; i++) acc = gfMul(acc, x) ^ cw[i]
    out[m] = acc
    if (acc !== 0) nonZero = true
  }
  return nonZero
}

export interface RsDecodeResult {
  /** The corrected message bytes (length codeword.length − nsym). */
  data: Uint8Array
  /** Number of byte errors that were corrected. */
  corrected: number
}

/**
 * Errors-only RS decode. Returns the corrected message, or `null` when the codeword
 * has more errors than the code can correct (detected via locator degree, root count,
 * out-of-range positions or a non-zero syndrome after correction). Never throws on
 * corrupted input. The input array is not modified.
 */
export function rsDecode(codeword: Uint8Array, nsym: number): RsDecodeResult | null {
  const n = codeword.length
  if (nsym < 1 || n <= nsym || n > 255) return null
  const k = n - nsym
  const synd = new Uint8Array(nsym)
  if (!syndromes(codeword, nsym, synd)) return { data: codeword.slice(0, k), corrected: 0 }

  // Berlekamp–Massey, polynomials lowest degree first.
  const C = new Uint8Array(nsym + 1)
  let B = new Uint8Array(nsym + 1)
  C[0] = 1
  B[0] = 1
  let L = 0
  let m = 1
  let b = 1
  for (let r = 0; r < nsym; r++) {
    let d = synd[r]
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i], synd[r - i])
    if (d === 0) {
      m++
      continue
    }
    const coef = gfDiv(d, b)
    if (2 * L <= r) {
      const T = C.slice()
      for (let i = 0; i + m <= nsym; i++) C[i + m] ^= gfMul(coef, B[i])
      L = r + 1 - L
      B = T
      b = d
      m = 1
    } else {
      for (let i = 0; i + m <= nsym; i++) C[i + m] ^= gfMul(coef, B[i])
      m++
    }
  }
  if (L * 2 > nsym) return null
  for (let i = L + 1; i <= nsym; i++) if (C[i] !== 0) return null

  // Chien search over the n valid positions (power j ↔ array index n−1−j).
  const positions: number[] = []
  for (let j = 0; j < n; j++) {
    const xinv = gfPow(-j)
    let acc = 0
    for (let i = L; i >= 0; i--) acc = gfMul(acc, xinv) ^ C[i]
    if (acc === 0) positions.push(j)
  }
  if (positions.length !== L) return null

  // Forney: Ω(x) = S(x)Λ(x) mod x^nsym; e = X·Ω(X⁻¹)/Λ'(X⁻¹) (first root α^0).
  const omega = new Uint8Array(nsym)
  for (let i = 0; i < nsym; i++) {
    let acc = 0
    for (let j = 0; j <= Math.min(i, L); j++) acc ^= gfMul(C[j], synd[i - j])
    omega[i] = acc
  }
  const out = codeword.slice()
  for (const j of positions) {
    const X = gfPow(j)
    const xinv = gfPow(-j)
    let num = 0
    for (let i = nsym - 1; i >= 0; i--) num = gfMul(num, xinv) ^ omega[i]
    let den = 0
    // Formal derivative: only odd-power terms survive in characteristic 2.
    for (let i = 1; i <= L; i += 2) den ^= gfMul(C[i], gfPow(-j * (i - 1)))
    if (den === 0) return null
    out[n - 1 - j] ^= gfMul(X, gfDiv(num, den))
  }
  if (syndromes(out, nsym, synd)) return null
  return { data: out.slice(0, k), corrected: L }
}

// ---------------------------------------------------------------------------
// Block plan + interleaving for the modem body
// ---------------------------------------------------------------------------

/** Maximum data bytes per RS block of the body. */
export const RS_BLOCK_DATA = 32
/** Parity bytes per body block (corrects up to 6 bad bytes per block). */
export const RS_BLOCK_PARITY = 12

/** Data sizes of the blocks a body of `dataLength` bytes is split into. */
export function planBlocks(dataLength: number): number[] {
  if (!Number.isInteger(dataLength) || dataLength < 1) throw new RangeError('empty body')
  const count = Math.ceil(dataLength / RS_BLOCK_DATA)
  const base = Math.floor(dataLength / count)
  const extra = dataLength % count
  const sizes: number[] = []
  for (let b = 0; b < count; b++) sizes.push(base + (b < extra ? 1 : 0))
  return sizes
}

/** Total coded length (data + parity) of a body of `dataLength` bytes. */
export function codedLength(dataLength: number): number {
  return dataLength + planBlocks(dataLength).length * RS_BLOCK_PARITY
}

/** RS-encode `data` in blocks and interleave the codewords byte by byte. */
export function encodeBlocks(data: Uint8Array): Uint8Array {
  const sizes = planBlocks(data.length)
  const words: Uint8Array[] = []
  let off = 0
  for (const s of sizes) {
    words.push(rsEncode(data.subarray(off, off + s), RS_BLOCK_PARITY))
    off += s
  }
  const out = new Uint8Array(codedLength(data.length))
  const maxLen = words[0].length
  let p = 0
  for (let j = 0; j < maxLen; j++) {
    for (const w of words) if (j < w.length) out[p++] = w[j]
  }
  return out
}

/** Inverse of {@link encodeBlocks}. Returns `null` if any block is uncorrectable. */
export function decodeBlocks(
  coded: Uint8Array,
  dataLength: number,
): { data: Uint8Array; corrected: number } | null {
  const sizes = planBlocks(dataLength)
  if (coded.length !== codedLength(dataLength)) return null
  const words = sizes.map((s) => new Uint8Array(s + RS_BLOCK_PARITY))
  const maxLen = words[0].length
  let p = 0
  for (let j = 0; j < maxLen; j++) {
    for (const w of words) if (j < w.length) w[j] = coded[p++]
  }
  const data = new Uint8Array(dataLength)
  let off = 0
  let corrected = 0
  for (const w of words) {
    const r = rsDecode(w, RS_BLOCK_PARITY)
    if (!r) return null
    data.set(r.data, off)
    off += r.data.length
    corrected += r.corrected
  }
  return { data, corrected }
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256)
;(() => {
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    CRC_TABLE[i] = c >>> 0
  }
})()

/** CRC-32 (IEEE) over the concatenation of `parts`. */
export function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}
