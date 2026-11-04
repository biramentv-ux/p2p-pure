import { describe, it, expect } from 'vitest'
import {
  encodeToSamples,
  estimateDurationMs,
  FskDecoder,
  MAX_AUDIO_PAYLOAD,
} from '../../../src/p2p/audio/fskModem'
import { addEcho, addNoise, pad, prng, randomBytes, resample, wobbleGain } from './helpers'

function feed(dec: FskDecoder, x: Float32Array, seed?: number): void {
  if (seed === undefined) {
    dec.push(x)
    return
  }
  const r = prng(seed)
  for (let i = 0; i < x.length; ) {
    const n = 1 + Math.floor(r() * 6000)
    dec.push(x.subarray(i, i + n))
    i += n
  }
}

function decode(x: Float32Array, rate: number, seed?: number): Uint8Array | null {
  const dec = new FskDecoder(rate)
  feed(dec, x, seed)
  return dec.result
}

describe('encoder', () => {
  it('keeps amplitude ≤ 0.8, starts and ends silent, matches the estimate', () => {
    for (const rate of [44100, 48000]) {
      const s = encodeToSamples(randomBytes(50, 1), rate)
      let peak = 0
      for (const v of s) peak = Math.max(peak, Math.abs(v))
      expect(peak).toBeLessThanOrEqual(0.8 + 1e-6)
      expect(Math.abs(s[0])).toBeLessThan(1e-3)
      expect(Math.abs(s[s.length - 1])).toBeLessThan(1e-6)
      expect(Math.abs(s.length / rate - estimateDurationMs(50) / 1000)).toBeLessThan(0.002)
    }
  })

  it('has no clicks: sample-to-sample jumps stay small', () => {
    const rate = 48000
    const s = encodeToSamples(randomBytes(30, 2), rate)
    let maxJump = 0
    for (let i = 1; i < s.length; i++) maxJump = Math.max(maxJump, Math.abs(s[i] - s[i - 1]))
    // Highest tone 5.5 kHz at 0.8: max slope 2π·5500/48000·0.8 ≈ 0.58.
    expect(maxJump).toBeLessThan(0.6)
  })

  it('meets the throughput target: 200 B ≤ 20 s, ≥ 12 B/s', () => {
    const ms = estimateDurationMs(200)
    expect(ms).toBeLessThanOrEqual(20000)
    expect(200 / (ms / 1000)).toBeGreaterThanOrEqual(12)
    expect(estimateDurationMs(220)).toBeLessThanOrEqual(20000)
  })

  it('rejects oversize payloads and bad rates', () => {
    expect(() => encodeToSamples(new Uint8Array(MAX_AUDIO_PAYLOAD + 1), 48000)).toThrow(RangeError)
    expect(() => encodeToSamples(new Uint8Array(1), 1000)).toThrow(RangeError)
    expect(() => estimateDurationMs(-1)).toThrow(RangeError)
  })
})

describe('round trips', () => {
  for (const n of [0, 1, 50, 200, 255]) {
    it(`${n} bytes, 48000 → 48000, random offset, chunked`, () => {
      const data = randomBytes(n, n + 7)
      const x = pad(encodeToSamples(data, 48000), 1000 + n * 37, 4000, 0.002, n)
      expect(decode(x, 48000, n + 100)).toEqual(data)
    })
  }

  it('44100 → 44100', () => {
    const data = randomBytes(80, 3)
    expect(decode(pad(encodeToSamples(data, 44100), 555, 3000, 0, 1), 44100)).toEqual(data)
  })

  it('reports locked/progress while receiving and keeps the result', () => {
    const data = randomBytes(60, 4)
    const x = pad(encodeToSamples(data, 48000), 2000, 4000, 0, 1)
    const dec = new FskDecoder(48000)
    expect(dec.progress).toBe(0)
    expect(dec.locked).toBe(false)
    let sawLock = false
    let last = 0
    for (let i = 0; i < x.length; i += 2048) {
      dec.push(x.subarray(i, i + 2048))
      if (dec.locked) {
        sawLock = true
        expect(dec.progress).toBeGreaterThanOrEqual(last)
        expect(dec.result).toBeNull()
        last = dec.progress
      }
    }
    expect(sawLock).toBe(true)
    expect(dec.result).toEqual(data)
    expect(dec.progress).toBe(1)
    dec.push(new Float32Array(1000)) // ignored once done
    expect(dec.result).toEqual(data)
    dec.reset()
    expect(dec.result).toBeNull()
    expect(dec.progress).toBe(0)
    feed(dec, x)
    expect(dec.result).toEqual(data)
  })
})

describe('channel impairments', () => {
  const cases: [string, number, number, number][] = [
    // [name, sender rate, receiver rate, clock drift]
    ['48000 → 44100', 48000, 44100, 0],
    ['44100 → 48000', 44100, 48000, 0],
    ['48000 → 44100, +0.5% drift', 48000, 44100, 0.005],
    ['44100 → 48000, −0.5% drift', 44100, 48000, -0.005],
  ]
  for (const [name, txRate, rxRate, drift] of cases) {
    it(`resampled ${name}`, () => {
      const data = randomBytes(200, txRate + Math.round(drift * 1e4))
      const tx = encodeToSamples(data, txRate)
      const rx = pad(resample(tx, txRate, rxRate, drift), 4321, 3000, 0.003, 9)
      expect(decode(rx, rxRate, 77)).toEqual(data)
    })
  }

  it('white Gaussian noise at 10 dB SNR', () => {
    for (const seed of [1, 2, 3]) {
      const data = randomBytes(200, 40 + seed)
      const x = addNoise(pad(encodeToSamples(data, 48000), 3000 * seed, 3000, 0, 0), 10, seed)
      expect(decode(x, 48000, seed)).toEqual(data)
    }
  })

  it('echo (5 ms, −6 dB) and reverb-like double echo', () => {
    const data = randomBytes(200, 50)
    const tx = pad(encodeToSamples(data, 48000), 999, 3000, 0, 0)
    expect(decode(addEcho(tx, 240, 0.5), 48000)).toEqual(data)
    expect(decode(addEcho(addEcho(tx, 150, 0.4), 420, 0.3), 48000)).toEqual(data)
  })

  it('±2% gain variation per symbol, plus much quieter input', () => {
    const data = randomBytes(150, 51)
    const tx = encodeToSamples(data, 48000)
    const wobbly = wobbleGain(pad(tx, 1500, 3000, 0.001, 3), 1200, 0.02, 4)
    expect(decode(wobbly, 48000, 5)).toEqual(data)
    const quiet = wobbly.map((v) => v * 0.02)
    expect(decode(quiet, 48000, 6)).toEqual(data)
  })

  it('everything at once: 48000 → 44100 +0.4% drift, echo, 10 dB noise, chunks', () => {
    const data = randomBytes(220, 52)
    const tx = resample(encodeToSamples(data, 48000), 48000, 44100, 0.004)
    const rx = addNoise(addEcho(pad(tx, 7000, 3000, 0, 0), 200, 0.4), 10, 8)
    expect(decode(rx, 44100, 9)).toEqual(data)
  })

  it('finds the frame after seconds of noise and a false start', () => {
    const data = randomBytes(40, 53)
    const tx = encodeToSamples(data, 48000)
    const truncated = tx.subarray(0, Math.floor(tx.length * 0.4)) // aborted first attempt
    const both = new Float32Array(truncated.length + 48000 + tx.length)
    both.set(truncated)
    both.set(tx, truncated.length + 48000)
    const x = addNoise(pad(both, 48000 * 2, 3000, 0, 0), 12, 10)
    expect(decode(x, 48000, 11)).toEqual(data)
  })
})

describe('integrity', () => {
  it('never returns data from a corrupted frame', () => {
    const data = randomBytes(100, 60)
    const tx = pad(encodeToSamples(data, 48000), 1000, 3000, 0, 0)
    // 1 s of loud noise is spread over all blocks by the interleaver and still corrected…
    const start = Math.floor(tx.length * 0.4)
    const r = prng(1)
    const hit = tx.slice()
    for (let i = start; i < start + 48000; i++) hit[i] = 0.8 * (2 * r() - 1)
    expect(decode(hit, 48000, 2)).toEqual(data)
    // …but 3 s is far beyond what RS can fix: no result, decoder back to searching.
    const bad = tx.slice()
    for (let i = start; i < start + 3 * 48000; i++) bad[i] = 0.8 * (2 * r() - 1)
    const dec = new FskDecoder(48000)
    feed(dec, bad, 3)
    expect(dec.result).toBeNull()
    expect(dec.locked).toBe(false)
  })

  it('pure noise and silence never produce a result', () => {
    const dec = new FskDecoder(44100)
    feed(dec, pad(new Float32Array(0), 44100 * 4, 0, 0.3, 12), 13)
    feed(dec, new Float32Array(44100))
    expect(dec.result).toBeNull()
    expect(dec.locked).toBe(false)
  })
})
