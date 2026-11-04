/**
 * Finder-marker detection for the light/colour transfer (M14).
 *
 * The four corner finders are QR-style concentric squares with run ratio 1:1:3:1:1
 * (black ring, white ring, black centre). Detection, in the spirit of ZXing/jsQR:
 *
 *   1. Luma Y = 0.2R + 0.7G + 0.1B (≈ WCAG weights; all data colours land at 124–142),
 *      then an adaptive threshold: a pixel is "dark" when Y < 0.85 · (box mean of Y
 *      around it). The data cells all have nearly the same
 *      relative luminance (flash safety) and differ only by chroma, so the data area never
 *      binarises dark — only the finders, the orientation tick and background clutter do.
 *   2. Every other row is run-length encoded; five consecutive runs dark/light/dark/light/dark
 *      in ratio 1:1:3:1:1 give a candidate centre.
 *   3. The candidate is cross-checked vertically (refines y), then horizontally again
 *      (refines x), and finally along one diagonal.
 *   4. Nearby candidates are merged into clusters; every hit row adds to the cluster count.
 *   5. Four clusters are chosen: similar module sizes, a convex quadrilateral whose sides
 *      are consistent with the module size, highest total count.
 *
 * Buffers are kept between calls and only reallocated when the image size changes.
 */

import type { Point } from './homography'

export interface FinderCandidate {
  x: number
  y: number
  /** Estimated finder module size in pixels (finder = 7 modules). */
  module: number
  count: number
}

/** Ratio check for 1:1:3:1:1 runs. */
function finderRatio(r0: number, r1: number, r2: number, r3: number, r4: number): number {
  const total = r0 + r1 + r2 + r3 + r4
  if (total < 7) return 0
  const m = total / 7
  const tol = m * 0.6
  if (Math.abs(r0 - m) >= tol || Math.abs(r1 - m) >= tol) return 0
  if (Math.abs(r3 - m) >= tol || Math.abs(r4 - m) >= tol) return 0
  if (Math.abs(r2 - 3 * m) >= m * 1.5) return 0
  return m
}

export class FinderDetector {
  private w = 0
  private h = 0
  /** Luminance, 0..255. */
  lum = new Uint8Array(0)
  private integral = new Uint32Array(0)
  private bin = new Uint8Array(0)

  /** Prepare luminance + binarised image. */
  private prepare(data: Uint8ClampedArray, w: number, h: number): void {
    if (w !== this.w || h !== this.h) {
      this.w = w
      this.h = h
      this.lum = new Uint8Array(w * h)
      this.integral = new Uint32Array((w + 1) * (h + 1))
      this.bin = new Uint8Array(w * h)
    }
    const lum = this.lum
    const ii = this.integral
    const W1 = w + 1
    for (let y = 0; y < h; y++) {
      let rowSum = 0
      const base = y * w
      for (let x = 0; x < w; x++) {
        const p = (base + x) * 4
        const v = (2 * data[p] + 7 * data[p + 1] + data[p + 2] + 5) / 10 | 0
        lum[base + x] = v
        rowSum += v
        ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + rowSum
      }
    }
    const r = Math.max(6, Math.round(Math.min(w, h) / 24))
    const bin = this.bin
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r)
      const y1 = Math.min(h, y + r + 1)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r)
        const x1 = Math.min(w, x + r + 1)
        const sum = ii[y1 * W1 + x1] - ii[y0 * W1 + x1] - ii[y1 * W1 + x0] + ii[y0 * W1 + x0]
        const area = (x1 - x0) * (y1 - y0)
        // dark ⇔ Y < 0.85 · mean, and at least 12 below it (keeps flat regions light)
        const Y = lum[y * w + x] * area
        bin[y * w + x] = Y * 100 < sum * 85 && Y + 12 * area < sum ? 1 : 0
      }
    }
  }

  private isDark(x: number, y: number): boolean {
    return this.bin[y * this.w + x] === 1
  }

  /**
   * Walk from (x, y) — which must be inside the centre dark run — in direction ±(dx, dy)
   * and return the 5 run lengths and the centre run's midpoint offset (along +d), or null.
   */
  private crossCheck(
    x: number,
    y: number,
    dx: number,
    dy: number,
    maxRun: number,
  ): { runs: [number, number, number, number, number]; mid: number } | null {
    const { w, h } = this
    if (!this.isDark(x, y)) return null
    const walk = (sx: number, sy: number): [number, number, number] | null => {
      // returns [centre part, light, outer dark] lengths
      const counts: [number, number, number] = [0, 0, 0]
      let cx = x
      let cy = y
      let state = 0
      for (;;) {
        cx += sx
        cy += sy
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) return state === 2 ? counts : null
        const d = this.isDark(cx, cy)
        if (state === 0) {
          if (d) counts[0]++
          else {
            state = 1
            counts[1] = 1
          }
        } else if (state === 1) {
          if (!d) counts[1]++
          else {
            state = 2
            counts[2] = 1
          }
        } else {
          if (d) counts[2]++
          else return counts
        }
        if (counts[state] > maxRun) return null
      }
    }
    const a = walk(-dx, -dy)
    if (!a) return null
    const b = walk(dx, dy)
    if (!b) return null
    const centre = a[0] + b[0] + 1
    const runs: [number, number, number, number, number] = [a[2], a[1], centre, b[1], b[2]]
    // centre run spans offsets [-a0, b0] → midpoint (b0 − a0)/2
    return { runs, mid: (b[0] - a[0]) / 2 }
  }

  /** Detect finder candidates (clusters) in an RGBA image. */
  detect(data: Uint8ClampedArray, w: number, h: number): FinderCandidate[] {
    this.prepare(data, w, h)
    const clusters: FinderCandidate[] = []
    const runStart = new Int32Array(w + 1)
    const runLen = new Int32Array(w + 1)
    const maxRun = Math.max(w, h) / 4
    for (let y = 1; y < h - 1; y += 2) {
      // run-length encode row y
      let n = 0
      let prev = -1
      const row = y * w
      for (let x = 0; x < w; x++) {
        const v = this.bin[row + x]
        if (v !== prev) {
          runStart[n] = x
          runLen[n] = 1
          n++
          prev = v
        } else runLen[n - 1]++
      }
      const firstDark = this.bin[row] === 1 ? 0 : 1
      for (let j = firstDark; j + 4 < n; j += 2) {
        const m = finderRatio(runLen[j], runLen[j + 1], runLen[j + 2], runLen[j + 3], runLen[j + 4])
        if (m === 0) continue
        let cx = runStart[j + 2] + runLen[j + 2] / 2
        let cy = y + 0.5
        // vertical
        const v = this.crossCheck(Math.floor(cx), y, 0, 1, maxRun)
        if (!v) continue
        const mv = finderRatio(...v.runs)
        if (mv === 0 || mv > m * 2 || m > mv * 2) continue
        cy = y + 0.5 + v.mid
        // horizontal again at refined y
        const hc = this.crossCheck(Math.floor(cx), Math.floor(cy), 1, 0, maxRun)
        if (!hc) continue
        const mh = finderRatio(...hc.runs)
        if (mh === 0) continue
        cx = Math.floor(cx) + 0.5 + hc.mid
        // diagonal sanity check
        const dg = this.crossCheck(Math.floor(cx), Math.floor(cy), 1, 1, maxRun)
        if (!dg || finderRatio(...dg.runs) === 0) continue
        const mod = (mv + mh) / 2
        this.addCandidate(clusters, cx, cy, mod)
      }
    }
    return clusters
  }

  private addCandidate(clusters: FinderCandidate[], x: number, y: number, m: number): void {
    for (const c of clusters) {
      if (Math.hypot(c.x - x, c.y - y) < 2.5 * Math.max(c.module, m) && m < c.module * 1.7 && c.module < m * 1.7) {
        const k = c.count
        c.x = (c.x * k + x) / (k + 1)
        c.y = (c.y * k + y) / (k + 1)
        c.module = (c.module * k + m) / (k + 1)
        c.count = k + 1
        return
      }
    }
    clusters.push({ x, y, module: m, count: 1 })
  }
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/** Sort four points cyclically around their centroid (either winding). */
export function cyclicOrder(pts: readonly Point[]): Point[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
  return pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx))
}

/**
 * Pick the four clusters that form the symbol. `sideModules` is the expected distance
 * between adjacent finder centres in finder modules. Returns cyclically ordered centres.
 */
export function selectFinders(cands: FinderCandidate[], sideModules: number): Point[] | null {
  const top = cands
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
  if (top.length < 4) return null
  let best: Point[] | null = null
  let bestScore = -1
  for (let a = 0; a < top.length; a++)
    for (let b = a + 1; b < top.length; b++)
      for (let c = b + 1; c < top.length; c++)
        for (let d = c + 1; d < top.length; d++) {
          const set = [top[a], top[b], top[c], top[d]]
          const mods = set.map((s) => s.module)
          const mMin = Math.min(...mods)
          const mMax = Math.max(...mods)
          if (mMax > mMin * 2) continue
          const mAvg = (mods[0] + mods[1] + mods[2] + mods[3]) / 4
          const pts = cyclicOrder(set.map((s): Point => [s.x, s.y]))
          // convex, consistent winding
          let sign = 0
          let ok = true
          for (let i = 0; i < 4 && ok; i++) {
            const z = cross(pts[i], pts[(i + 1) % 4], pts[(i + 2) % 4])
            if (z === 0) ok = false
            else if (sign === 0) sign = Math.sign(z)
            else if (Math.sign(z) !== sign) ok = false
          }
          if (!ok) continue
          for (let i = 0; i < 4 && ok; i++) {
            const p = pts[i]
            const q = pts[(i + 1) % 4]
            const side = Math.hypot(p[0] - q[0], p[1] - q[1]) / mAvg
            if (side < sideModules * 0.55 || side > sideModules * 1.6) ok = false
          }
          if (!ok) continue
          const score = set.reduce((s, x) => s + x.count, 0)
          if (score > bestScore) {
            bestScore = score
            best = pts
          }
        }
  return best
}
