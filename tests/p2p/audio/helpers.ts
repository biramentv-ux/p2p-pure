/** Test-only signal helpers for the audio modem: seeded PRNG, channel impairments. */

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

/**
 * Linear-interpolation resampler. Output sample n reads input at n · step, where
 * step = (inRate / outRate) · (1 + drift). `drift` models clock error on top of the
 * declared-rate conversion.
 */
export function resample(x: Float32Array, inRate: number, outRate: number, drift = 0): Float32Array {
  const step = (inRate / outRate) * (1 + drift)
  const len = Math.floor((x.length - 1) / step)
  const out = new Float32Array(len)
  for (let n = 0; n < len; n++) {
    const t = n * step
    const i = Math.floor(t)
    const f = t - i
    out[n] = x[i] * (1 - f) + x[i + 1] * f
  }
  return out
}

/** Prepend `lead` and append `trail` samples of Gaussian noise (σ = sigma). */
export function pad(x: Float32Array, lead: number, trail: number, sigma: number, seed: number): Float32Array {
  const g = gaussian(prng(seed))
  const out = new Float32Array(lead + x.length + trail)
  for (let i = 0; i < out.length; i++) out[i] = sigma > 0 ? sigma * g() : 0
  for (let i = 0; i < x.length; i++) out[lead + i] += x[i]
  return out
}

/** Add white Gaussian noise for the given SNR (dB) relative to a tone of amplitude 0.8. */
export function addNoise(x: Float32Array, snrDb: number, seed: number): Float32Array {
  const signalPower = (0.8 * 0.8) / 2
  const sigma = Math.sqrt(signalPower / 10 ** (snrDb / 10))
  const g = gaussian(prng(seed))
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i] + sigma * g()
  return out
}

/** y = x + gain · x delayed by `delay` samples (simple room echo). */
export function addEcho(x: Float32Array, delay: number, gain: number): Float32Array {
  const out = new Float32Array(x.length + delay)
  for (let i = 0; i < x.length; i++) {
    out[i] += x[i]
    out[i + delay] += gain * x[i]
  }
  return out
}

/** Slow gain wobble: a different random gain in [1−depth, 1+depth] per `period` samples. */
export function wobbleGain(x: Float32Array, period: number, depth: number, seed: number): Float32Array {
  const r = prng(seed)
  const out = new Float32Array(x.length)
  let g = 1
  for (let i = 0; i < x.length; i++) {
    if (i % period === 0) g = 1 + depth * (2 * r() - 1)
    out[i] = x[i] * g
  }
  return out
}
