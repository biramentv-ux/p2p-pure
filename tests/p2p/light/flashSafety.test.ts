// @vitest-environment node
/**
 * Photosensitivity guards (WCAG 2.3.1 / 2.3.2). See the header of src/p2p/light/lightCodec.ts.
 * Luminance is WCAG 2.x relative luminance: L = 0.2126 R + 0.7152 G + 0.0722 B on linearised sRGB.
 */
import { describe, it, expect } from 'vitest'
import {
  encodeLightFrames,
  LIGHT_FPS,
  LIGHT_LAYOUT,
  LIGHT_PALETTE,
  LIGHT_SYMBOL_UNITS,
  rasterizeFrame,
} from '../../../src/p2p/light/lightCodec'
import { randomBytes } from './helpers'

function lin(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
function relLum(r: number, g: number, b: number): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const PAL_L = LIGHT_PALETTE.map(([r, g, b]) => relLum(r, g, b))

describe('flash safety', () => {
  it('changes frames at most 3 times per second', () => {
    expect(LIGHT_FPS).toBeGreaterThan(0)
    expect(LIGHT_FPS).toBeLessThanOrEqual(3)
  })

  it('palette colours have nearly equal relative luminance', () => {
    const spread = Math.max(...PAL_L) - Math.min(...PAL_L)
    expect(spread).toBeLessThan(0.01)
    // no colour change between two data colours exceeds 0.25 (by a wide margin)
    for (const a of PAL_L) for (const b of PAL_L) expect(Math.abs(a - b)).toBeLessThanOrEqual(0.25)
  })

  it('contains no saturated red (WCAG red flash: R/(R+G+B) ≥ 0.8 in linear light)', () => {
    for (const [r, g, b] of LIGHT_PALETTE) {
      const R = lin(r)
      const G = lin(g)
      const B = lin(b)
      expect(R / (R + G + B)).toBeLessThanOrEqual(0.6)
      expect(r).toBeLessThanOrEqual(g + b) // not R-dominant in sRGB either
    }
  })

  it('palette colours stay separable by chroma', () => {
    const ch = LIGHT_PALETTE.map(([r, g, b]) => [r / (r + g + b), g / (r + g + b), b / (r + g + b)])
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) {
        expect(Math.hypot(ch[i][0] - ch[j][0], ch[i][1] - ch[j][1], ch[i][2] - ch[j][2])).toBeGreaterThan(0.2)
      }
  })

  it('mean pattern luminance and per-cell luminance barely change between consecutive frames', () => {
    let maxMean = 0
    let maxCell = 0
    for (const len of [0, 1, 50, 220, 255]) {
      const frames = encodeLightFrames(randomBytes(len, len + 1))
      // consecutive includes the loop-around (last → first)
      for (let i = 0; i < frames.length; i++) {
        const a = frames[i].cells
        const b = frames[(i + 1) % frames.length].cells
        let ma = 0
        let mb = 0
        for (let c = 0; c < a.length; c++) {
          ma += PAL_L[a[c]]
          mb += PAL_L[b[c]]
          maxCell = Math.max(maxCell, Math.abs(PAL_L[a[c]] - PAL_L[b[c]]))
        }
        maxMean = Math.max(maxMean, Math.abs(ma - mb) / a.length)
      }
    }
    expect(maxMean).toBeLessThanOrEqual(0.02)
    expect(maxCell).toBeLessThanOrEqual(0.25)
  })

  it('only data cells change between rendered frames; finders and quiet zone are static', () => {
    const frames = encodeLightFrames(randomBytes(220, 3))
    const n = LIGHT_SYMBOL_UNITS * 6
    const u = n / LIGHT_SYMBOL_UNITS
    const lo = 5 * u
    const hi = (5 + LIGHT_LAYOUT.cols) * u
    const imgs = frames.map((f) => rasterizeFrame(f, n, n))
    let maxMean = 0
    for (let k = 0; k < imgs.length; k++) {
      const a = imgs[k]
      const b = imgs[(k + 1) % imgs.length]
      let la = 0
      let lb = 0
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const p = (y * n + x) * 4
          const inData = x >= lo && x < hi && y >= lo && y < hi
          if (!inData) {
            expect(a[p]).toBe(b[p])
            expect(a[p + 1]).toBe(b[p + 1])
            expect(a[p + 2]).toBe(b[p + 2])
          }
          la += relLum(a[p], a[p + 1], a[p + 2])
          lb += relLum(b[p], b[p + 1], b[p + 2])
        }
      }
      maxMean = Math.max(maxMean, Math.abs(la - lb) / (n * n))
    }
    expect(maxMean).toBeLessThanOrEqual(0.02)
  })

  it('data colours never use black or white (only the static markers do)', () => {
    for (const L of PAL_L) {
      expect(L).toBeGreaterThan(0.2)
      expect(L).toBeLessThan(0.4)
    }
  })
})
