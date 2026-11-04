// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  BODY_PER_FRAME,
  encodeLightBody,
  encodeLightFrames,
  estimateLightDurationMs,
  FRAME_BYTES,
  LIGHT_FPS,
  LIGHT_LAYOUT,
  LIGHT_PALETTE,
  LIGHT_SYMBOL_UNITS,
  LightDecoder,
  lightFrameCount,
  rasterizeFrame,
  type LightFrame,
} from '../../../src/p2p/light/lightCodec'
import { crc32 } from '../../../src/p2p/audio/fec'
import { blend, prng, randomBytes } from './helpers'

const N = LIGHT_SYMBOL_UNITS * 8 // 8 px per cell: clean, fast raster
const CELLS = LIGHT_LAYOUT.cols * LIGHT_LAYOUT.rows

function px(frame: LightFrame, size = N): { data: Uint8ClampedArray; width: number; height: number } {
  return { data: rasterizeFrame(frame, size, size), width: size, height: size }
}

function decodeLoop(frames: LightFrame[], start = 0, maxPushes = frames.length * 3): { dec: LightDecoder; pushes: number } {
  const dec = new LightDecoder()
  let pushes = 0
  while (!dec.result && pushes < maxPushes) {
    dec.push(px(frames[(start + pushes) % frames.length]))
    pushes++
  }
  return { dec, pushes }
}

describe('encoder', () => {
  it('has the expected geometry and rate', () => {
    expect(LIGHT_FPS).toBeLessThanOrEqual(3)
    expect(LIGHT_PALETTE).toHaveLength(4)
    expect(CELLS % 4).toBe(0)
    expect(FRAME_BYTES).toBe(CELLS / 4)
    expect(BODY_PER_FRAME).toBe(FRAME_BYTES - 16)
  })

  it('makes deterministic frames with sequential indices and valid palette indices', () => {
    const data = randomBytes(220, 1)
    const a = encodeLightFrames(data)
    const b = encodeLightFrames(data)
    expect(a.length).toBe(lightFrameCount(220))
    a.forEach((f, i) => {
      expect(f.index).toBe(i)
      expect(f.cells).toHaveLength(CELLS)
      expect(Math.max(...f.cells)).toBeLessThan(4)
      expect(f.cells).toEqual(b[i].cells)
    })
  })

  it('reports the carousel duration (≤ ~8 s for 220 bytes)', () => {
    expect(estimateLightDurationMs(220)).toBe(Math.round((lightFrameCount(220) * 1000) / LIGHT_FPS))
    expect(estimateLightDurationMs(220)).toBeLessThanOrEqual(8000)
    expect(lightFrameCount(0)).toBeGreaterThanOrEqual(1)
  })

  it('rejects oversized payloads and bad raster sizes', () => {
    expect(() => encodeLightFrames(new Uint8Array(256))).toThrow(RangeError)
    const f = encodeLightFrames(new Uint8Array(1))[0]
    expect(() => rasterizeFrame(f, 0, 10)).toThrow(RangeError)
  })

  it('uses all four colours in every frame (whitening)', () => {
    for (const len of [0, 1, 220]) {
      for (const f of encodeLightFrames(new Uint8Array(len))) {
        const hist = [0, 0, 0, 0]
        for (const c of f.cells) hist[c]++
        for (const h of hist) expect(h).toBeGreaterThan(CELLS / 10)
      }
    }
  })

  it('rasterizes the quiet zone white and pads non-square canvases with white', () => {
    const f = encodeLightFrames(new Uint8Array(5))[0]
    const img = rasterizeFrame(f, 300, 200)
    expect(img).toHaveLength(300 * 200 * 4)
    for (const [x, y] of [
      [0, 0],
      [299, 199],
      [10, 100],
    ]) {
      const p = (y * 300 + x) * 4
      expect([img[p], img[p + 1], img[p + 2], img[p + 3]]).toEqual([255, 255, 255, 255])
    }
  })
})

describe('round trip (clean raster)', () => {
  for (const len of [0, 1, 50, 220, 255]) {
    it(`${len} bytes`, () => {
      const data = randomBytes(len, 100 + len)
      const frames = encodeLightFrames(data)
      const { dec, pushes } = decodeLoop(frames)
      expect(dec.result).toEqual(data)
      expect(pushes).toBe(frames.length)
      expect(dec.progress).toBe(1)
      expect(dec.locked).toBe(true)
    })
  }

  it('joins mid-carousel', () => {
    const data = randomBytes(220, 7)
    const frames = encodeLightFrames(data)
    const { dec, pushes } = decodeLoop(frames, 6)
    expect(dec.result).toEqual(data)
    expect(pushes).toBe(frames.length)
  })

  it('reports progress per distinct frame and ignores duplicates', () => {
    const data = randomBytes(100, 8)
    const frames = encodeLightFrames(data)
    const dec = new LightDecoder()
    expect(dec.progress).toBe(0)
    expect(dec.locked).toBe(false)
    dec.push(px(frames[0]))
    dec.push(px(frames[0]))
    expect(dec.progress).toBeCloseTo(1 / frames.length)
    for (let i = 1; i < frames.length; i++) {
      expect(dec.result).toBeNull()
      dec.push(px(frames[i]))
    }
    expect(dec.result).toEqual(data)
    // further pushes are ignored
    dec.push(px(frames[0]))
    expect(dec.result).toEqual(data)
    dec.reset()
    expect(dec.result).toBeNull()
    expect(dec.progress).toBe(0)
  })

  it('is not locked on an empty or tiny image', () => {
    const dec = new LightDecoder()
    dec.push({ data: new Uint8ClampedArray(320 * 240 * 4).fill(128), width: 320, height: 240 })
    expect(dec.locked).toBe(false)
    dec.push({ data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 })
    expect(dec.locked).toBe(false)
    expect(dec.progress).toBe(0)
  })
})

describe('error handling', () => {
  it('RS corrects several wrong cells per frame', () => {
    const data = randomBytes(220, 9)
    const frames = encodeLightFrames(data).map((f, i): LightFrame => {
      const cells = f.cells.slice()
      const r = prng(1000 + i)
      // 6 wrong cells in 6 different bytes (= the per-frame RS limit of 6 bytes)
      const bytes = new Set<number>()
      while (bytes.size < 6) bytes.add(Math.floor(r() * FRAME_BYTES))
      for (const b of bytes) {
        const c = 4 * b + Math.floor(r() * 4)
        cells[c] = (cells[c] + 1 + Math.floor(r() * 3)) % 4
      }
      return { index: f.index, cells }
    })
    const { dec } = decodeLoop(frames)
    expect(dec.result).toEqual(data)
  })

  it('drops a frame with too many wrong cells and recovers from the next cycle', () => {
    const data = randomBytes(220, 10)
    const frames = encodeLightFrames(data)
    const bad = frames[4].cells.slice()
    for (let c = 0; c < 60; c++) bad[c * 3] = (bad[c * 3] + 2) % 4
    const dec = new LightDecoder()
    for (const f of frames) dec.push(px(f.index === 4 ? { index: 4, cells: bad } : f))
    expect(dec.result).toBeNull()
    expect(dec.progress).toBeCloseTo((frames.length - 1) / frames.length)
    dec.push(px(frames[4]))
    expect(dec.result).toEqual(data)
  })

  it('rejects a 50/50 blend of two consecutive frames (captured mid-transition)', () => {
    const data = randomBytes(220, 11)
    const frames = encodeLightFrames(data)
    const dec = new LightDecoder()
    const mixed = blend(rasterizeFrame(frames[3], N, N), rasterizeFrame(frames[4], N, N), 0.5)
    dec.push({ data: mixed, width: N, height: N })
    expect(dec.locked).toBe(true) // finders are static, so still found
    expect(dec.progress).toBe(0) // …but no frame was accepted
    for (const f of frames) {
      if (f.index === 3) dec.push({ data: mixed, width: N, height: N })
      dec.push(px(f))
    }
    expect(dec.result).toEqual(data)
  })

  it('rejects a rolling-shutter capture (top half one frame, bottom half the next)', () => {
    const frames = encodeLightFrames(randomBytes(220, 12))
    const a = rasterizeFrame(frames[2], N, N)
    const b = rasterizeFrame(frames[3], N, N)
    const torn = a.slice()
    torn.set(b.subarray((N / 2) * N * 4), (N / 2) * N * 4)
    const dec = new LightDecoder()
    dec.push({ data: torn, width: N, height: N })
    expect(dec.progress).toBe(0)
  })

  it('CRC rejects a stream whose payload does not match its checksum', () => {
    const data = randomBytes(120, 13)
    const body = new Uint8Array(124)
    body.set(data)
    const crc = crc32(Uint8Array.of(1, data.length), data) ^ 0x00010000
    new DataView(body.buffer).setUint32(120, crc)
    const frames = encodeLightBody(body, data.length)
    const { dec } = decodeLoop(frames, 0, frames.length * 3)
    expect(dec.result).toBeNull()
  })

  it('switches to a new stream only after it is seen consistently', () => {
    const old = encodeLightFrames(randomBytes(220, 14))
    const data = randomBytes(60, 15)
    const fresh = encodeLightFrames(data)
    const dec = new LightDecoder()
    for (let i = 0; i < 4; i++) dec.push(px(old[i]))
    let k = 0
    while (!dec.result && k < fresh.length * 2) dec.push(px(fresh[k++ % fresh.length]))
    expect(dec.result).toEqual(data)
  })
})
