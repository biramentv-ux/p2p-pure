/**
 * Light / colour transfer for M14 ("QR one way + flashing screen back").
 *
 * Like the M7 sound path, the responder returns its compact signed answer
 * (src/p2p/compactAnswer.ts, ≤ 220 bytes) to the initiator — here as a slowly changing grid
 * of coloured cells on its screen, read by the initiator's camera (10–40 cm, hand-held).
 *
 * ───────────────────────────── PHOTOSENSITIVITY SAFETY ─────────────────────────────
 * This animation must never be a flashing hazard (WCAG 2.3.1 "Three Flashes or Below
 * Threshold", 2.3.2 "Three Flashes"). The rules below are hard requirements and are
 * asserted by tests/p2p/light/flashSafety.test.ts — do not change the palette, the frame
 * rate or the layout without keeping those tests green:
 *
 *   1. At most 3 frame changes per second: {@link LIGHT_FPS} = 3 (must stay ≤ 3). The UI must
 *      switch frames on a fixed timer at exactly this rate, without fades/CSS transitions.
 *   2. Cells only, no full-screen flashes. Everything outside the data cells (white quiet
 *      zone and bands, black/white finder markers, orientation tick) is static and never
 *      changes for the whole session.
 *   3. All data colours have (nearly) the same WCAG relative luminance (0.2825–0.2862), so
 *      cells differ by chroma only. A cell changing colour changes its luminance by ≤ 0.004
 *      (limit 0.25) and the mean luminance of the whole pattern by far less than 0.02 between
 *      consecutive frames. There is therefore no luminance "flash" at all in WCAG terms.
 *   4. No saturated red: no data colour has a linear red share R/(R+G+B) ≥ 0.8 (WCAG "red
 *      flash" definition; the largest is the yellow at 0.50, then magenta 0.42), none is R-dominant
 *      (R > G + B in sRGB).
 *   5. High-contrast finder markers exist only at the four corners and never change.
 * ────────────────────────────────────────────────────────────────────────────────────
 *
 * Symbol geometry (in units u = one data cell; T = cols + 10 units square):
 *
 *   0..1          white quiet zone around everything
 *   corners       finders 3.5u × 3.5u (7 modules of 0.5u, QR-like 1:1:3:1:1 rings), centred
 *                 2.75u from the symbol edges, separated from the data by ≥ 0.5u of white
 *   top band      orientation tick: a black 1.5u square at x ∈ [6.5, 8], y ∈ [2, 3.5].
 *                 It sits at one of the 8 dihedral positions, so the reader resolves any
 *                 rotation (0/90/180/270°) and mirroring (front cameras) from it.
 *   [5, 5 + cols] data cells, row-major; colour = palette index (2 bits per cell)
 *
 * Frame content (one Reed–Solomon codeword per frame, {@link FRAME_BYTES} bytes = cols·rows/4):
 *
 *   [0]   version (high nibble, = 1), low nibble 0
 *   [1]   payload length L (0..255)
 *   [2]   frame count N of the carousel
 *   [3]   frame index i (0..N−1)
 *   [4..] body slice: bytes i·BODY_PER_FRAME … of the coded body (zero-padded in the last frame)
 *   +12   RS parity over the above (fec.ts rsEncode, corrects up to 6 wrong bytes = ≥ 6 wrong
 *         cells per frame)
 *   The whole codeword is XORed with a fixed pseudo-random mask (whitening): every frame uses
 *   all four colours roughly equally (helps the adaptive colour classifier) and two different
 *   frames differ in most cells (a frame captured mid-transition then fails RS instead of
 *   decoding to something plausible).
 *
 * Coded body = fec.ts encodeBlocks(payload ‖ CRC-32(version, L, payload)) — RS blocks of
 * ≤ 32 + 12 bytes, byte-interleaved, so the blocks are spread over all frames. The sender
 * loops the frame list forever; the receiver joins at any frame and finishes after it has
 * seen every index once (one cycle). `result` is set only after the outer RS and the CRC pass.
 *
 * Reader (LightDecoder.push, one camera frame at a time):
 *   finders (finders.ts) → 4 centres → for each of the 8 corner assignments a homography
 *   (perspective) from symbol units to the image → the orientation tick decides which one →
 *   white balance from the white bands and the black finder centres → each cell centre is
 *   averaged over a 3×3 window → normalised-rgb chroma (brightness-independent) → nearest
 *   palette colour, refined by 2 k-means iterations per frame (absorbs the camera's colour
 *   rendering) → unmask → RS decode → header check → per-index vote (a frame read twice
 *   consistently beats a frame read once) → when all indices are present: outer RS + CRC.
 *
 * Pure TypeScript, deterministic, no timers, no DOM, no dependencies beyond fec.ts.
 */

import { codedLength, crc32, decodeBlocks, encodeBlocks, rsDecode, rsEncode } from '../audio/fec'
import { FinderDetector, selectFinders } from './finders'
import { applyHomography, solveHomography, type Point } from './homography'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Frame changes per second. Photosensitivity limit: must be ≤ 3. */
export const LIGHT_FPS = 3

/**
 * sRGB data colours, all with WCAG relative luminance ≈ 0.284 (see header):
 * 0 yellow-olive, 1 green, 2 blue, 3 violet-magenta.
 */
export const LIGHT_PALETTE: readonly [number, number, number][] = Object.freeze([
  [150, 150, 0],
  [20, 168, 72],
  [92, 140, 255],
  [226, 76, 255],
] as [number, number, number][])

export interface LightLayout {
  cols: number
  rows: number
}

/** Data cells per frame (quiet zone, bands and finders come on top, see header). */
export const LIGHT_LAYOUT: LightLayout = Object.freeze({ cols: 14, rows: 14 })

/** Side of the whole square symbol in data-cell units (cols + quiet zone + finder bands). */
export const LIGHT_SYMBOL_UNITS = LIGHT_LAYOUT.cols + 10

export const MAX_LIGHT_PAYLOAD = 255

export interface LightFrame {
  readonly index: number
  /** Palette index per data cell, row-major, length cols·rows. */
  readonly cells: Uint8Array
}

// ---------------------------------------------------------------------------
// Frame format
// ---------------------------------------------------------------------------

const VERSION = 1
const CELLS = LIGHT_LAYOUT.cols * LIGHT_LAYOUT.rows
/** Bytes per frame codeword (4 cells per byte). */
export const FRAME_BYTES = CELLS / 4
const FRAME_PARITY = 12
const HEADER_BYTES = 4
/** Coded-body bytes carried per frame. */
export const BODY_PER_FRAME = FRAME_BYTES - FRAME_PARITY - HEADER_BYTES
const CRC_BYTES = 4

const BAND = 5 // quiet 1 + finder 3.5 + gap 0.5
const T = LIGHT_SYMBOL_UNITS
const FINDER_C = 2.75 // finder centre offset from the symbol edge
const FINDER_HALF = 1.75
const TICK: readonly [number, number, number, number] = [6.5, 2, 8, 3.5] // x0, y0, x1, y1

const MASK = (() => {
  const m = new Uint8Array(FRAME_BYTES)
  let s = 0x9e3779b9 >>> 0
  for (let i = 0; i < FRAME_BYTES; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    m[i] = s & 0xff
  }
  return m
})()

function checkLength(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_LIGHT_PAYLOAD) {
    throw new RangeError(`light payload must be 0..${MAX_LIGHT_PAYLOAD} bytes`)
  }
}

/** Number of frames in the carousel for a payload of `byteLength` bytes. */
export function lightFrameCount(byteLength: number): number {
  checkLength(byteLength)
  return Math.ceil(codedLength(byteLength + CRC_BYTES) / BODY_PER_FRAME)
}

/** One full carousel cycle in ms (what a receiver joining at any frame needs at best). */
export function estimateLightDurationMs(byteLength: number): number {
  return Math.round((lightFrameCount(byteLength) * 1000) / LIGHT_FPS)
}

function bytesToCells(cw: Uint8Array): Uint8Array {
  const cells = new Uint8Array(CELLS)
  for (let j = 0; j < FRAME_BYTES; j++) {
    const b = cw[j] ^ MASK[j]
    cells[4 * j] = (b >> 6) & 3
    cells[4 * j + 1] = (b >> 4) & 3
    cells[4 * j + 2] = (b >> 2) & 3
    cells[4 * j + 3] = b & 3
  }
  return cells
}

function cellsToBytes(cells: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_BYTES)
  for (let j = 0; j < FRAME_BYTES; j++) {
    out[j] =
      ((cells[4 * j] << 6) | (cells[4 * j + 1] << 4) | (cells[4 * j + 2] << 2) | cells[4 * j + 3]) ^ MASK[j]
  }
  return out
}

/**
 * @internal Build the carousel for an already CRC-suffixed body (`payload ‖ crc`), exposed
 * so tests can forge a stream whose CRC does not match. Use {@link encodeLightFrames}.
 */
export function encodeLightBody(bodyWithCrc: Uint8Array, payloadLength: number): LightFrame[] {
  checkLength(payloadLength)
  if (bodyWithCrc.length !== payloadLength + CRC_BYTES) throw new RangeError('body length mismatch')
  const coded = encodeBlocks(bodyWithCrc)
  const count = Math.ceil(coded.length / BODY_PER_FRAME)
  const frames: LightFrame[] = []
  for (let i = 0; i < count; i++) {
    const msg = new Uint8Array(HEADER_BYTES + BODY_PER_FRAME)
    msg[0] = VERSION << 4
    msg[1] = payloadLength
    msg[2] = count
    msg[3] = i
    msg.set(coded.subarray(i * BODY_PER_FRAME, (i + 1) * BODY_PER_FRAME), HEADER_BYTES)
    frames.push(Object.freeze({ index: i, cells: bytesToCells(rsEncode(msg, FRAME_PARITY)) }))
  }
  return frames
}

/** Encode `data` (0..255 bytes) as a carousel of frames; the sender loops it forever. */
export function encodeLightFrames(data: Uint8Array): LightFrame[] {
  checkLength(data.length)
  const body = new Uint8Array(data.length + CRC_BYTES)
  body.set(data)
  const crc = crc32(Uint8Array.of(VERSION, data.length), data)
  new DataView(body.buffer).setUint32(data.length, crc)
  return encodeLightBody(body, data.length)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const WHITE = 255
const BLACK = 0

/** Is the static (non-data) symbol point (u, v) black? Points in the data area return false. */
function staticDark(u: number, v: number): boolean {
  // finders
  const fx = u < T / 2 ? FINDER_C : T - FINDER_C
  const fy = v < T / 2 ? FINDER_C : T - FINDER_C
  const d = Math.max(Math.abs(u - fx), Math.abs(v - fy))
  if (d < FINDER_HALF) return d >= 1.25 || d < 0.75
  return u >= TICK[0] && u < TICK[2] && v >= TICK[1] && v < TICK[3]
}

/**
 * Render `frame` into a new RGBA buffer of `width × height`. The square symbol is scaled to
 * fit and centred; the remaining area is white (part of the static quiet zone).
 */
export function rasterizeFrame(frame: LightFrame, width: number, height: number): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('bad raster size')
  }
  if (frame.cells.length !== CELLS) throw new RangeError('bad frame')
  const out = new Uint8ClampedArray(width * height * 4)
  const scale = Math.min(width, height) / T
  const ox = (width - scale * T) / 2
  const oy = (height - scale * T) / 2
  const { cols, rows } = LIGHT_LAYOUT
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5 - oy) / scale
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5 - ox) / scale
      const p = (y * width + x) * 4
      out[p + 3] = 255
      if (u >= BAND && u < BAND + cols && v >= BAND && v < BAND + rows) {
        const c = LIGHT_PALETTE[frame.cells[Math.floor(v - BAND) * cols + Math.floor(u - BAND)]]
        out[p] = c[0]
        out[p + 1] = c[1]
        out[p + 2] = c[2]
      } else {
        const g = u >= 0 && v >= 0 && u < T && v < T && staticDark(u, v) ? BLACK : WHITE
        out[p] = g
        out[p + 1] = g
        out[p + 2] = g
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

export interface LightImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Finder centres in symbol units, in cyclic (clockwise in y-down coordinates) order. */
const SYMBOL_CORNERS: readonly Point[] = [
  [FINDER_C, FINDER_C],
  [T - FINDER_C, FINDER_C],
  [T - FINDER_C, T - FINDER_C],
  [FINDER_C, T - FINDER_C],
]
const TICK_CENTRE: Point = [(TICK[0] + TICK[2]) / 2, (TICK[1] + TICK[3]) / 2]
const WHITE_REFS: readonly Point[] = [
  [T / 2, FINDER_C],
  [T / 2, T - FINDER_C],
  [FINDER_C, T / 2],
  [T - FINDER_C, T / 2],
]

/** Palette chroma (normalised rgb) used to seed the classifier. */
const PALETTE_CHROMA = LIGHT_PALETTE.map(([r, g, b]) => {
  const s = r + g + b
  return [r / s, g / s, b / s] as const
})

interface Vote {
  body: Uint8Array
  n: number
}

interface Header {
  length: number
  count: number
}

const MIN_SPAN = 24 // minimum white − black difference (0..255) to trust a frame

export class LightDecoder {
  private readonly finder = new FinderDetector()
  private header: Header | null = null
  private votes = new Map<number, Vote[]>()
  private foreign: { header: Header; streak: number } | null = null
  private _locked = false
  private _result: Uint8Array | null = null
  // per-push scratch
  private readonly sample = new Float32Array(CELLS * 3)
  private readonly cls = new Uint8Array(CELLS)

  get result(): Uint8Array | null {
    return this._result
  }

  get locked(): boolean {
    return this._locked
  }

  get progress(): number {
    if (this._result) return 1
    if (!this.header) return 0
    return this.votes.size / this.header.count
  }

  reset(): void {
    this.header = null
    this.votes.clear()
    this.foreign = null
    this._locked = false
    this._result = null
  }

  push(image: LightImage): void {
    if (this._result) return
    const { data, width, height } = image
    if (width < 16 || height < 16 || data.length < width * height * 4) {
      this._locked = false
      return
    }
    const cands = this.finder.detect(data, width, height)
    const centres = selectFinders(cands, (T - 2 * FINDER_C) * 2)
    this._locked = centres !== null
    if (!centres) return

    // 8 assignments of detected centres to symbol corners (4 rotations × 2 windings).
    const options: { h: Float64Array; tick: number }[] = []
    const lum = this.finder.lum
    for (let rot = 0; rot < 4; rot++) {
      for (let mir = 0; mir < 2; mir++) {
        const dst: Point[] = []
        for (let k = 0; k < 4; k++) dst.push(centres[(rot + (mir ? 4 - k : k)) % 4])
        const h = solveHomography(SYMBOL_CORNERS, dst)
        if (!h) continue
        const t = sampleLum(lum, width, height, h, TICK_CENTRE, 0.4)
        if (Number.isNaN(t)) continue
        options.push({ h, tick: t })
      }
    }
    if (options.length === 0) return
    options.sort((a, b) => a.tick - b.tick)
    // Try the two most plausible orientations.
    for (const opt of options.slice(0, 2)) {
      if (this.tryFrame(data, width, height, opt.h, opt.tick)) return
    }
  }

  private tryFrame(data: Uint8ClampedArray, w: number, h: number, H: Float64Array, tick: number): boolean {
    // White / black references.
    const white = [0, 0, 0]
    const black = [0, 0, 0]
    for (const p of WHITE_REFS) {
      const s = sampleRgb(data, w, h, H, p, 0.5)
      if (!s) return false
      for (let c = 0; c < 3; c++) white[c] += s[c] / 4
    }
    for (const p of SYMBOL_CORNERS) {
      const s = sampleRgb(data, w, h, H, p, 0.25)
      if (!s) return false
      for (let c = 0; c < 3; c++) black[c] += s[c] / 4
    }
    const wl = (white[0] + 2 * white[1] + white[2]) / 4
    const bl = (black[0] + 2 * black[1] + black[2]) / 4
    if (wl - bl < MIN_SPAN) return false
    if (tick > (wl + bl) / 2) return false // orientation tick not dark: not our symbol / not oriented

    // Sample and white-balance every cell.
    const { cols } = LIGHT_LAYOUT
    const S = this.sample
    for (let i = 0; i < CELLS; i++) {
      const u = BAND + (i % cols) + 0.5
      const v = BAND + Math.floor(i / cols) + 0.5
      const s = sampleRgb(data, w, h, H, [u, v], 0.22)
      if (!s) return false
      let sum = 0
      for (let c = 0; c < 3; c++) {
        const x = Math.max(0.003, (s[c] - black[c]) / Math.max(1, white[c] - black[c]))
        S[3 * i + c] = x
        sum += x
      }
      for (let c = 0; c < 3; c++) S[3 * i + c] /= sum
    }
    classify(S, this.cls)
    const cw = cellsToBytes(this.cls)
    const dec = rsDecode(cw, FRAME_PARITY)
    if (!dec) return false
    const m = dec.data
    if (m[0] !== VERSION << 4) return false
    const length = m[1]
    const count = m[2]
    const index = m[3]
    if (count !== lightFrameCount(length) || index >= count) return false
    this.accept({ length, count }, index, m.slice(HEADER_BYTES))
    return true
  }

  private accept(hdr: Header, index: number, body: Uint8Array): void {
    if (!this.header) this.header = hdr
    if (hdr.length !== this.header.length || hdr.count !== this.header.count) {
      // A different stream (e.g. the responder restarted with a new answer). Switch only after
      // three consecutive valid frames agree on the new header.
      const f = this.foreign
      if (f && f.header.length === hdr.length && f.header.count === hdr.count) f.streak++
      else this.foreign = { header: hdr, streak: 1 }
      if (this.foreign!.streak < 3) return
      this.header = hdr
      this.votes.clear()
      this.foreign = null
    } else this.foreign = null

    const list = this.votes.get(index) ?? []
    const same = list.find((v) => equalBytes(v.body, body))
    if (same) same.n++
    else list.push({ body, n: 1 })
    this.votes.set(index, list)
    if (this.votes.size === this.header.count) this.finish()
  }

  private finish(): void {
    const hdr = this.header!
    const coded = new Uint8Array(hdr.count * BODY_PER_FRAME)
    for (let i = 0; i < hdr.count; i++) coded.set(best(this.votes.get(i)!).body, i * BODY_PER_FRAME)
    const n = codedLength(hdr.length + CRC_BYTES)
    const r = decodeBlocks(coded.subarray(0, n), hdr.length + CRC_BYTES)
    if (r) {
      const payload = r.data.subarray(0, hdr.length)
      const crc = new DataView(r.data.buffer, r.data.byteOffset).getUint32(hdr.length)
      if (crc32(Uint8Array.of(VERSION, hdr.length), payload) === crc) {
        this._result = payload.slice()
        return
      }
    }
    // Failed: forget the frames that were only read once and collect again.
    let removed = false
    for (const [i, list] of this.votes) {
      if (best(list).n < 2) {
        this.votes.delete(i)
        removed = true
      }
    }
    if (!removed) this.votes.clear()
  }
}

function best(list: Vote[]): Vote {
  let b = list[0]
  for (const v of list) if (v.n > b.n) b = v
  return b
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Mean luminance in a 3×3 grid of points ±r units around symbol point p; NaN if outside. */
function sampleLum(lum: Uint8Array, w: number, h: number, H: Float64Array, p: Point, r: number): number {
  let sum = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [x, y] = applyHomography(H, p[0] + dx * r, p[1] + dy * r)
      const xi = Math.floor(x)
      const yi = Math.floor(y)
      if (!(xi >= 0 && yi >= 0 && xi < w && yi < h)) return NaN
      sum += lum[yi * w + xi]
    }
  }
  return sum / 9
}

/** Mean RGB in a 3×3 grid of points ±r units around symbol point p; null if outside. */
function sampleRgb(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  H: Float64Array,
  p: Point,
  r: number,
): [number, number, number] | null {
  let R = 0
  let G = 0
  let B = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [x, y] = applyHomography(H, p[0] + dx * r, p[1] + dy * r)
      const xi = Math.floor(x)
      const yi = Math.floor(y)
      if (!(xi >= 0 && yi >= 0 && xi < w && yi < h)) return null
      const q = (yi * w + xi) * 4
      R += data[q]
      G += data[q + 1]
      B += data[q + 2]
    }
  }
  return [R / 9, G / 9, B / 9]
}

/** Nearest-chroma classification seeded by the palette, refined by 2 k-means iterations. */
function classify(S: Float32Array, out: Uint8Array): void {
  const cent = PALETTE_CHROMA.map((c) => [c[0], c[1], c[2]])
  const n = out.length
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < n; i++) {
      let bi = 0
      let bd = Infinity
      for (let k = 0; k < 4; k++) {
        const d0 = S[3 * i] - cent[k][0]
        const d1 = S[3 * i + 1] - cent[k][1]
        const d2 = S[3 * i + 2] - cent[k][2]
        const d = d0 * d0 + d1 * d1 + d2 * d2
        if (d < bd) {
          bd = d
          bi = k
        }
      }
      out[i] = bi
    }
    if (iter === 2) break
    const acc = [0, 0, 0, 0].map(() => [0, 0, 0, 0])
    for (let i = 0; i < n; i++) {
      const a = acc[out[i]]
      a[0] += S[3 * i]
      a[1] += S[3 * i + 1]
      a[2] += S[3 * i + 2]
      a[3]++
    }
    for (let k = 0; k < 4; k++) {
      // keep the seed when a class is (nearly) empty
      if (acc[k][3] >= 4) cent[k] = [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]]
    }
  }
}
