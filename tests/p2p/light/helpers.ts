/** Test-only image helpers for the light codec: seeded PRNG, warps and camera impairments. */

import { solveHomography, applyHomography, type Point } from '../../../src/p2p/light/homography'
import type { LightImage } from '../../../src/p2p/light/lightCodec'

/** mulberry32: small deterministic PRNG returning floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12)
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

export function randomBytes(n: number, seed: number): Uint8Array {
  const r = prng(seed)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(r() * 256)
  return out
}

export function image(data: Uint8ClampedArray, width: number, height: number): LightImage {
  return { data, width, height }
}

/**
 * Where the four corners of a square source land after a 3-D tilt (rx, ry degrees around
 * the x / y axes), an in-plane rotation rz, perspective projection and placement in an
 * output of `outW × outH`, with the symbol covering about `fill` of the shorter side.
 */
export function tiltCorners(
  outW: number,
  outH: number,
  rx: number,
  ry: number,
  rz: number,
  fill = 0.8,
  shift: Point = [0, 0],
): Point[] {
  const d2r = Math.PI / 180
  const [cx, sx] = [Math.cos(rx * d2r), Math.sin(rx * d2r)]
  const [cy, sy] = [Math.cos(ry * d2r), Math.sin(ry * d2r)]
  const [cz, sz] = [Math.cos(rz * d2r), Math.sin(rz * d2r)]
  const f = 2.5 // camera distance in symbol half-sizes
  const pts: Point[] = []
  for (const [u, v] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    // rz, then ry, then rx
    let x = u * cz - v * sz
    let y = u * sz + v * cz
    let z = 0
    ;[x, z] = [x * cy + z * sy, -x * sy + z * cy]
    ;[y, z] = [y * cx - z * sx, y * sx + z * cx]
    const k = f / (f + z)
    pts.push([x * k, y * k])
  }
  const s = (Math.min(outW, outH) * fill) / 2 / 1.25
  return pts.map(([x, y]): Point => [outW / 2 + shift[0] + x * s, outH / 2 + shift[1] + y * s])
}

/**
 * A precomputed perspective warp: the square RGBA source (side `n`) has its corners
 * (TL, TR, BR, BL) land on `corners` in a `w × h` output. Bilinear sampling; outside the
 * symbol the output shows `bg` plus a few random dark/light blobs (desk clutter) from `seed`.
 * The mapping is computed once, so warping many frames with the same pose is cheap.
 */
export class Warper {
  private readonly idx: Int32Array
  private readonly ax: Float32Array
  private readonly ay: Float32Array
  private readonly back: Uint8ClampedArray
  private readonly n: number
  readonly w: number
  readonly h: number
  constructor(
    n: number,
    w: number,
    h: number,
    corners: readonly Point[],
    seed = 1,
    bg: [number, number, number] = [70, 64, 58],
  ) {
    const H = solveHomography(corners, [
      [0, 0],
      [n, 0],
      [n, n],
      [0, n],
    ])
    if (!H) throw new Error('degenerate warp')
    this.n = n
    this.w = w
    this.h = h
    this.idx = new Int32Array(w * h).fill(-1)
    this.ax = new Float32Array(w * h)
    this.ay = new Float32Array(w * h)
    this.back = new Uint8ClampedArray(w * h * 4)
    const r = prng(seed)
    const blobs: [number, number, number, number][] = []
    for (let i = 0; i < 6; i++) blobs.push([r() * w, r() * h, 10 + r() * 40, r() < 0.5 ? 20 : 200])
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const [u, v] = applyHomography(H, x + 0.5, y + 0.5)
        const fx = u - 0.5
        const fy = v - 0.5
        if (fx >= 0 && fy >= 0 && fx < n - 1 && fy < n - 1) {
          const x0 = Math.floor(fx)
          const y0 = Math.floor(fy)
          this.idx[i] = y0 * n + x0
          this.ax[i] = fx - x0
          this.ay[i] = fy - y0
        }
        let g: [number, number, number] = bg
        for (const [bx, by, br, bv] of blobs) if (Math.hypot(x - bx, y - by) < br) g = [bv, bv, bv]
        this.back[i * 4] = g[0]
        this.back[i * 4 + 1] = g[1]
        this.back[i * 4 + 2] = g[2]
        this.back[i * 4 + 3] = 255
      }
    }
  }

  apply(src: Uint8ClampedArray): Uint8ClampedArray {
    const { n, w, h, idx, ax, ay } = this
    const out = this.back.slice()
    for (let i = 0; i < w * h; i++) {
      const q0 = idx[i]
      if (q0 < 0) continue
      const a = ax[i]
      const b = ay[i]
      const q = q0 * 4
      const r = q + n * 4
      const p = i * 4
      for (let c = 0; c < 3; c++) {
        const top = src[q + c] + (src[q + 4 + c] - src[q + c]) * a
        const bot = src[r + c] + (src[r + 4 + c] - src[r + c]) * a
        out[p + c] = top + (bot - top) * b
      }
    }
    return out
  }
}

/** Separable box blur of radius r, applied `passes` times (3 passes ≈ Gaussian). */
export function blur(img: Uint8ClampedArray, w: number, h: number, r: number, passes = 3): Uint8ClampedArray {
  let a = Float32Array.from(img)
  let b = new Float32Array(a.length)
  const d = 2 * r + 1
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0
        for (let k = -r; k <= r; k++) acc += a[(y * w + Math.min(w - 1, Math.max(0, k))) * 4 + c]
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 4 + c] = acc / d
          const xa = Math.min(w - 1, x + r + 1)
          const xr = Math.max(0, x - r)
          acc += a[(y * w + xa) * 4 + c] - a[(y * w + xr) * 4 + c]
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0
        for (let k = -r; k <= r; k++) acc += b[(Math.min(h - 1, Math.max(0, k)) * w + x) * 4 + c]
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 4 + c] = acc / d
          const ya = Math.min(h - 1, y + r + 1)
          const yr = Math.max(0, y - r)
          acc += b[(ya * w + x) * 4 + c] - b[(yr * w + x) * 4 + c]
        }
      }
    }
  }
  const out = new Uint8ClampedArray(img.length)
  for (let i = 0; i < out.length; i++) out[i] = (i & 3) === 3 ? 255 : a[i]
  return out
}

/** Per-channel gain (brightness × colour cast), then additive Gaussian noise σ (0..255 units). */
const NOISE = (() => {
  const g = gaussian(prng(0x5eed))
  const t = new Float32Array(1 << 16)
  for (let i = 0; i < t.length; i++) t[i] = g()
  return t
})()

export function camera(
  img: Uint8ClampedArray,
  gain: [number, number, number],
  sigma: number,
  seed: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.length)
  // Gaussian noise from a fixed table, read from a seeded random start with an odd stride.
  const r = prng(seed)
  let k = Math.floor(r() * NOISE.length)
  const stride = 1 + 2 * Math.floor(r() * 5000)
  const mask = NOISE.length - 1
  for (let i = 0; i < img.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out[i + c] = img[i + c] * gain[c] + sigma * NOISE[k]
      k = (k + stride) & mask
    }
    out[i + 3] = 255
  }
  return out
}

/** Pixel-wise blend t·a + (1−t)·b. */
export function blend(a: Uint8ClampedArray, b: Uint8ClampedArray, t: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.length)
  for (let i = 0; i < a.length; i++) out[i] = t * a[i] + (1 - t) * b[i]
  return out
}

/** Rotate a square RGBA image by 90° clockwise `quarter` times. */
export function rotateSquare(img: Uint8ClampedArray, n: number, quarter: number): Uint8ClampedArray {
  let cur = img
  for (let q = 0; q < ((quarter % 4) + 4) % 4; q++) {
    const out = new Uint8ClampedArray(cur.length)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        // (x, y) → (n−1−y, x)
        const s = (y * n + x) * 4
        const d = (x * n + (n - 1 - y)) * 4
        out[d] = cur[s]
        out[d + 1] = cur[s + 1]
        out[d + 2] = cur[s + 2]
        out[d + 3] = cur[s + 3]
      }
    }
    cur = out
  }
  return cur
}

/** Mirror a square RGBA image horizontally (front camera). */
export function mirrorSquare(img: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.length)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const s = (y * n + x) * 4
      const d = (y * n + (n - 1 - x)) * 4
      for (let c = 0; c < 4; c++) out[d + c] = img[s + c]
    }
  }
  return out
}
