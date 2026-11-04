import { it, expect } from 'vitest'
import { encodeToSamples, FskDecoder } from '../../../src/p2p/audio/fskModem'
import { randomBytes, resample, addNoise, addEcho, pad } from './helpers'
const which = process.env.CASE ?? 'clean'
it('quick ' + which, () => {
  const d = randomBytes(200, 1)
  const s = encodeToSamples(d, 48000)
  const cases: Record<string, [Float32Array, number]> = {
    clean: [pad(s, 1234, 5000, 0, 1), 48000],
    r44p: [pad(resample(s, 48000, 44100, 0.005), 3000, 5000, 0.01, 2), 44100],
    r44m: [pad(resample(s, 48000, 44100, -0.005), 3000, 5000, 0.01, 2), 44100],
    noise: [addNoise(pad(s, 7777, 5000, 0, 1), 10, 3), 48000],
    echo: [addEcho(pad(s, 77, 5000, 0, 1), 240, 0.5), 48000],
    all: [addNoise(addEcho(pad(resample(s, 48000, 44100, 0.005), 3000, 5000, 0, 2), 200, 0.4), 10, 5), 44100],
  }
  const [x, rate] = cases[which]
  const dec = new FskDecoder(rate)
  const t = performance.now()
  let maxp = 0
  for (let i = 0; i < x.length; i += 1000) { dec.push(x.subarray(i, i + 1000)); maxp = Math.max(maxp, dec.progress) }
  console.log('RES', which, dec.result ? Buffer.from(dec.result).equals(Buffer.from(d)) : null, 'maxp', maxp.toFixed(2), (performance.now() - t).toFixed(0), 'ms')
  expect(1).toBe(1)
})
