// @vitest-environment node
/**
 * Synthetic camera captures: the rasterized symbol is warped with a perspective homography
 * (tilt up to ±20°), placed in a 640×480 / 1280×720 frame with desk clutter, rotated,
 * mirrored, blurred, recoloured (brightness × white balance) and noised.
 */
import { describe, it, expect } from 'vitest'
import {
  encodeLightFrames,
  LIGHT_SYMBOL_UNITS,
  LightDecoder,
  rasterizeFrame,
  type LightFrame,
} from '../../../src/p2p/light/lightCodec'
import { blend, blur, camera, mirrorSquare, prng, randomBytes, rotateSquare, tiltCorners, Warper } from './helpers'

const SRC = LIGHT_SYMBOL_UNITS * 10 // source raster, 10 px per cell

interface Scene {
  w: number
  h: number
  tilt: [number, number, number] // rx, ry, rz degrees
  fill?: number
  quarter?: number
  mirror?: boolean
  blurR?: number
  gain?: [number, number, number]
  sigma?: number
}

function capture(frame: LightFrame | Uint8ClampedArray, warper: Warper, s: Scene, seed: number) {
  let img = frame instanceof Uint8ClampedArray ? frame : rasterizeFrame(frame, SRC, SRC)
  if (s.quarter) img = rotateSquare(img, SRC, s.quarter)
  if (s.mirror) img = mirrorSquare(img, SRC)
  img = warper.apply(img)
  if (s.blurR) img = blur(img, s.w, s.h, s.blurR)
  if (s.gain || s.sigma) img = camera(img, s.gain ?? [1, 1, 1], s.sigma ?? 0, seed)
  return { data: img, width: s.w, height: s.h }
}

function run(s: Scene, data: Uint8Array, seed: number, start = 0) {
  const frames = encodeLightFrames(data)
  const warper = new Warper(SRC, s.w, s.h, tiltCorners(s.w, s.h, ...s.tilt, s.fill ?? 0.8), seed)
  const dec = new LightDecoder()
  let pushes = 0
  while (!dec.result && pushes < frames.length * 2) {
    dec.push(capture(frames[(start + pushes) % frames.length], warper, s, seed * 1000 + pushes))
    pushes++
  }
  return { dec, pushes, frames }
}

const DATA = randomBytes(220, 42)

describe('camera captures (220 bytes)', () => {
  const scenes: [string, Scene][] = [
    ['640×480, tilt 20°/−15°, small blur, noise', { w: 640, h: 480, tilt: [20, -15, 5], blurR: 1, sigma: 5 }],
    ['1280×720, tilt −18°/20°, rotated 12°', { w: 1280, h: 720, tilt: [-18, 20, 12], blurR: 1, sigma: 4 }],
    ['rotated 90°', { w: 640, h: 480, tilt: [10, 8, 0], quarter: 1, sigma: 3 }],
    ['rotated 180°', { w: 640, h: 480, tilt: [-8, 12, 3], quarter: 2, sigma: 3 }],
    ['rotated 270°', { w: 640, h: 480, tilt: [12, -10, -4], quarter: 3, sigma: 3 }],
    ['mirrored (front camera)', { w: 640, h: 480, tilt: [10, 15, 2], mirror: true, blurR: 1, sigma: 3 }],
    ['mirrored + rotated 90°', { w: 640, h: 480, tilt: [-10, 5, 0], mirror: true, quarter: 1, sigma: 3 }],
    ['dim (×0.5) + warm white balance', { w: 640, h: 480, tilt: [12, -12, 4], gain: [0.55, 0.5, 0.36], sigma: 3 }],
    ['bright (×1.5, clipped) + cool cast', { w: 640, h: 480, tilt: [-12, 12, -4], gain: [1.35, 1.5, 1.65], sigma: 4 }],
    ['heavier blur (≈ 1.2 cells/3 px) + noise σ 8', { w: 640, h: 480, tilt: [15, 0, 0], blurR: 2, sigma: 8 }],
    ['small in frame (fill 0.55)', { w: 640, h: 480, tilt: [8, 8, 0], fill: 0.55, sigma: 3 }],
  ]
  scenes.forEach(([name, s], i) => {
    it(name, () => {
      const { dec, pushes, frames } = run(s, DATA, 10 + i, i)
      expect(dec.result).toEqual(DATA)
      expect(pushes).toBe(frames.length)
    })
  })

  it('accepts a duplicated frame and rejects a blended (mid-transition) one', () => {
    const s: Scene = { w: 640, h: 480, tilt: [12, -8, 3], blurR: 1, sigma: 4 }
    const frames = encodeLightFrames(DATA)
    const warper = new Warper(SRC, s.w, s.h, tiltCorners(s.w, s.h, ...s.tilt), 3)
    const dec = new LightDecoder()
    const mixed = blend(rasterizeFrame(frames[5], SRC, SRC), rasterizeFrame(frames[6], SRC, SRC), 0.5)
    let seed = 1
    for (const f of frames) {
      if (f.index === 2) dec.push(capture(f, warper, s, seed++)) // duplicate
      if (f.index === 6) {
        const before = dec.progress
        dec.push(capture(mixed, warper, s, seed++))
        expect(dec.locked).toBe(true)
        expect(dec.progress).toBe(before) // blend not accepted as any frame
      }
      dec.push(capture(f, warper, s, seed++))
    }
    expect(dec.result).toEqual(DATA)
  })

  it('stays unlocked on a frame without the symbol', () => {
    const r = prng(5)
    const img = new Uint8ClampedArray(640 * 480 * 4)
    for (let i = 0; i < img.length; i++) img[i] = (i & 3) === 3 ? 255 : 60 + r() * 120
    const dec = new LightDecoder()
    dec.push({ data: img, width: 640, height: 480 })
    expect(dec.locked).toBe(false)
    expect(dec.progress).toBe(0)
  })

  it('decodes small payloads (0 and 1 byte) through the camera path', () => {
    for (const len of [0, 1]) {
      const data = randomBytes(len, 77)
      const { dec } = run({ w: 640, h: 480, tilt: [10, -10, 0], blurR: 1, sigma: 4 }, data, 50 + len)
      expect(dec.result).toEqual(data)
    }
  })
})
