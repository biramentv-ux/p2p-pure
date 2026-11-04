/**
 * Acoustic modem for M7 ("QR one way + sound back"): bytes ↔ audio samples.
 *
 * Signal layout (times at the sender's nominal rate):
 *
 *   lead-in   150 ms  soft 2.5 kHz tone fading in (wakes speaker amps / mic paths)
 *   chirp A    80 ms  linear up-chirp 1.8 → 5.5 kHz
 *   gap        70 ms  silence
 *   chirp B    80 ms  identical up-chirp, starts exactly 150 ms after chirp A
 *   gap        30 ms  silence (lets the chirp's echo decay)
 *   header     20 symbols   [magic|version, length] + 8 RS parity bytes
 *   body       N symbols    RS blocks (≤ 32 data + 12 parity, byte-interleaved) of
 *                           payload ‖ CRC-32(header ‖ payload)
 *   tail      100 ms  silence
 *
 * Modulation: 16-ary FSK, 4 bits per 25 ms symbol (40 symbols/s, 160 bit/s raw).
 * 32 tones are spaced evenly over 1.8–5.5 kHz (≈119 Hz apart); even symbols use the
 * even-indexed tones and odd symbols the odd-indexed ones, so the echo/reverb tail of
 * the previous symbol lands on tones the receiver is not looking at, and a timing error
 * of a few ms only costs energy instead of producing a wrong tone. Each symbol has
 * 2.5 ms raised-cosine ramps and peak amplitude 0.8 (no clicks).
 *
 * Receiver: streaming FFT cross-correlation (overlap-save) against the complex chirp
 * finds chirp A and B anywhere in the input; their spacing gives the sender/receiver
 * clock ratio r (declared-rate resampling error + drift, accepted within ±1%), which
 * then scales both symbol timing and tone frequencies. Each symbol is demodulated with
 * Hann-windowed Goertzel filters over 18 ms inside the symbol; a slow early/late
 * tracker absorbs residual drift. `result` is only set after RS decoding and a
 * CRC-32 match, so partial or corrupted data is never returned.
 *
 * Pure TypeScript, deterministic, no timers; buffers are allocated once per decoder
 * (the sample buffer grows by doubling and is compacted in place).
 */

import { codedLength, crc32, decodeBlocks, encodeBlocks, rsDecode, rsEncode } from './fec'

export const MAX_AUDIO_PAYLOAD = 255

// ---------------------------------------------------------------------------
// Parameters (seconds / Hz)
// ---------------------------------------------------------------------------

const F_LOW = 1800
const F_HIGH = 5500
const TONE_COUNT = 32
const TONES_PER_SET = 16
const TONE_STEP = (F_HIGH - F_LOW) / (TONE_COUNT - 1)

const SYMBOL_SEC = 0.025
const SYMBOL_RAMP_SEC = 0.0025
const AMPLITUDE = 0.8

const LEAD_IN_SEC = 0.15
const LEAD_IN_FREQ = 2500
const LEAD_IN_AMP = 0.3
const CHIRP_SEC = 0.08
const CHIRP_RAMP_SEC = 0.004
const CHIRP_SPACING_SEC = 0.15 // start of chirp A → start of chirp B
const POST_CHIRP_GAP_SEC = 0.03
const TAIL_SEC = 0.1
/** Data symbols start this long after the start of chirp A. */
const DATA_OFFSET_SEC = CHIRP_SPACING_SEC + CHIRP_SEC + POST_CHIRP_GAP_SEC

const HEADER_MAGIC = 0x70
const HEADER_VERSION = 1
const HEADER_DATA = 2
const HEADER_PARITY = 8
const HEADER_SYMBOLS = (HEADER_DATA + HEADER_PARITY) * 2
const CRC_BYTES = 4

// Receiver
const WINDOW_START_SEC = 0.0035
const WINDOW_SEC = 0.018
const TRACK_DELTA_SEC = 0.001
const TRACK_GAIN = 0.15
const TRACK_LIMIT_SEC = 0.006
const DETECT_THRESHOLD = 0.35
const PAIR_MIN_RATIO = 0.6 // chirp B must be at least this fraction of chirp A's score
const PEAK_HOLD_SEC = 0.008
const RATIO_TOLERANCE = 0.01
const FFT_SIZE = 8192

function toneFrequency(symbolIndex: number, value: number): number {
  return F_LOW + (2 * value + (symbolIndex & 1)) * TONE_STEP
}

function bodySymbols(byteLength: number): number {
  return codedLength(byteLength + CRC_BYTES) * 2
}

function totalSeconds(byteLength: number): number {
  const symbols = HEADER_SYMBOLS + bodySymbols(byteLength)
  return LEAD_IN_SEC + DATA_OFFSET_SEC + symbols * SYMBOL_SEC + TAIL_SEC
}

/** Length of the transmission for a payload of `byteLength` bytes, in milliseconds. */
export function estimateDurationMs(byteLength: number): number {
  checkLength(byteLength)
  return Math.round(totalSeconds(byteLength) * 1000)
}

function checkLength(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_AUDIO_PAYLOAD) {
    throw new RangeError(`audio payload must be 0..${MAX_AUDIO_PAYLOAD} bytes`)
  }
}

function checkRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000 || sampleRate > 192000) {
    throw new RangeError('unsupported sample rate')
  }
}

/** Raised-cosine envelope: 0 → 1 over `ramp` samples at both ends of `len`. */
function envelope(i: number, len: number, ramp: number): number {
  if (ramp <= 0) return 1
  if (i < ramp) return 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / ramp)
  const j = len - 1 - i
  if (j < ramp) return 0.5 - 0.5 * Math.cos((Math.PI * (j + 0.5)) / ramp)
  return 1
}

/** Chirp phase at time t seconds (instantaneous frequency F_LOW → F_HIGH over CHIRP_SEC). */
function chirpPhase(t: number): number {
  const k = (F_HIGH - F_LOW) / CHIRP_SEC
  return 2 * Math.PI * (F_LOW * t + 0.5 * k * t * t)
}

function writeChirp(out: Float32Array, start: number, sampleRate: number): void {
  const len = Math.round(CHIRP_SEC * sampleRate)
  const ramp = Math.round(CHIRP_RAMP_SEC * sampleRate)
  for (let i = 0; i < len; i++) {
    out[start + i] = AMPLITUDE * envelope(i, len, ramp) * Math.cos(chirpPhase(i / sampleRate))
  }
}

function frameHeader(length: number): Uint8Array {
  return new Uint8Array([HEADER_MAGIC | HEADER_VERSION, length])
}

/**
 * Encode `data` (0..255 bytes) as a complete transmission at `sampleRate` Hz:
 * lead-in, chirp preamble, RS-protected header, RS-protected body with CRC-32, tail.
 */
export function encodeToSamples(data: Uint8Array, sampleRate: number): Float32Array {
  checkLength(data.length)
  checkRate(sampleRate)
  const header = frameHeader(data.length)
  const crc = crc32(header, data)
  const body = new Uint8Array(data.length + CRC_BYTES)
  body.set(data)
  body[data.length] = crc >>> 24
  body[data.length + 1] = (crc >>> 16) & 0xff
  body[data.length + 2] = (crc >>> 8) & 0xff
  body[data.length + 3] = crc & 0xff
  const headerCoded = rsEncode(header, HEADER_PARITY)
  const bodyCoded = encodeBlocks(body)

  const symbolCount = (headerCoded.length + bodyCoded.length) * 2
  const out = new Float32Array(Math.ceil(totalSeconds(data.length) * sampleRate))

  // Lead-in: soft tone fading in, fading out quickly before chirp A.
  const leadLen = Math.round(LEAD_IN_SEC * sampleRate)
  const leadFadeOut = Math.round(0.02 * sampleRate)
  for (let i = 0; i < leadLen; i++) {
    const fadeIn = i / leadLen
    const fadeOut = i >= leadLen - leadFadeOut ? (leadLen - i) / leadFadeOut : 1
    out[i] = LEAD_IN_AMP * fadeIn * fadeOut * Math.sin((2 * Math.PI * LEAD_IN_FREQ * i) / sampleRate)
  }

  const chirpA = leadLen
  writeChirp(out, chirpA, sampleRate)
  writeChirp(out, chirpA + Math.round(CHIRP_SPACING_SEC * sampleRate), sampleRate)

  const symLen = Math.round(SYMBOL_SEC * sampleRate)
  const ramp = Math.round(SYMBOL_RAMP_SEC * sampleRate)
  const dataStart = chirpA + DATA_OFFSET_SEC * sampleRate
  for (let k = 0; k < symbolCount; k++) {
    const byteIndex = k >> 1
    const byte =
      byteIndex < headerCoded.length
        ? headerCoded[byteIndex]
        : bodyCoded[byteIndex - headerCoded.length]
    const value = k & 1 ? byte & 0x0f : byte >> 4
    const w = (2 * Math.PI * toneFrequency(k, value)) / sampleRate
    const start = Math.round(dataStart + k * SYMBOL_SEC * sampleRate)
    for (let i = 0; i < symLen; i++) {
      out[start + i] = AMPLITUDE * envelope(i, symLen, ramp) * Math.sin(w * i)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// FFT (radix-2, in place, complex)
// ---------------------------------------------------------------------------

class Fft {
  readonly n: number
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(n: number) {
    this.n = n
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
  }

  /** Forward transform (inverse when `inverse`, unscaled). */
  run(re: Float64Array, im: Float64Array, inverse: boolean): void {
    const n = this.n
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }
    const sign = inverse ? -1 : 1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = this.cos[j * step]
          const wi = sign * this.sin[j * step]
          const a = start + j
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

interface Peak {
  t: number
  score: number
}

const Phase = { Search: 0, Receive: 1, Done: 2 } as const
type Phase = (typeof Phase)[keyof typeof Phase]

export class FskDecoder {
  private readonly fs: number
  // sample buffer: buf[i] is absolute sample bufStart + i, valid up to bufLen
  private buf: Float32Array
  private bufStart = 0
  private bufLen = 0

  // search
  private readonly fft: Fft
  private readonly tplRe: Float64Array
  private readonly tplIm: Float64Array
  private readonly tplEnergy: number
  private readonly tplLen: number
  private readonly hop: number
  private readonly wre: Float64Array
  private readonly wim: Float64Array
  private readonly prefix: Float64Array
  private scanPos = 0
  private prevScore = 0
  private clusterActive = false
  private clusterBest = 0
  private clusterBestScore = 0
  private clusterPrev = 0
  private clusterNext = 0
  private peaks: Peak[] = []

  // receive
  private phase: Phase = Phase.Search as Phase
  private frameStart = 0 // chirp A start (absolute samples, fractional)
  private ratio = 1
  private symbolIndex = 0
  private totalSymbols = HEADER_SYMBOLS
  private payloadLength = -1
  private track = 0
  private readonly coded: Uint8Array
  private readonly winLen: number
  private readonly hann: Float32Array
  private readonly seg: Float32Array
  private readonly coeffs: Float64Array // [symbol parity][value]
  private _result: Uint8Array | null = null

  constructor(sampleRate: number) {
    checkRate(sampleRate)
    this.fs = sampleRate
    this.buf = new Float32Array(1 << 16)
    this.fft = new Fft(FFT_SIZE)

    // Complex chirp template (analytic signal), FFT precomputed.
    const L = Math.round(CHIRP_SEC * sampleRate)
    const ramp = Math.round(CHIRP_RAMP_SEC * sampleRate)
    this.tplLen = L
    this.hop = FFT_SIZE - L + 1
    this.tplRe = new Float64Array(FFT_SIZE)
    this.tplIm = new Float64Array(FFT_SIZE)
    let energy = 0
    for (let i = 0; i < L; i++) {
      const e = envelope(i, L, ramp)
      const ph = chirpPhase(i / sampleRate)
      this.tplRe[i] = e * Math.cos(ph)
      this.tplIm[i] = e * Math.sin(ph)
      energy += e * e
    }
    this.tplEnergy = energy
    this.fft.run(this.tplRe, this.tplIm, false)
    this.wre = new Float64Array(FFT_SIZE)
    this.wim = new Float64Array(FFT_SIZE)
    this.prefix = new Float64Array(FFT_SIZE + 1)

    this.coded = new Uint8Array(HEADER_DATA + HEADER_PARITY + codedLength(MAX_AUDIO_PAYLOAD + CRC_BYTES))
    this.winLen = Math.round(WINDOW_SEC * sampleRate)
    this.hann = new Float32Array(this.winLen)
    for (let i = 0; i < this.winLen; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / this.winLen)
    }
    this.seg = new Float32Array(this.winLen)
    this.coeffs = new Float64Array(2 * TONES_PER_SET)
  }

  get result(): Uint8Array | null {
    return this._result
  }

  get locked(): boolean {
    return this.phase === Phase.Receive
  }

  get progress(): number {
    if (this.phase === Phase.Done) return 1
    if (this.phase !== Phase.Receive) return 0
    if (this.payloadLength < 0) return (0.05 * this.symbolIndex) / HEADER_SYMBOLS
    return Math.min(1, this.symbolIndex / this.totalSymbols)
  }

  reset(): void {
    this.bufStart = 0
    this.bufLen = 0
    this.scanPos = 0
    this.prevScore = 0
    this.clusterActive = false
    this.peaks = []
    this.phase = Phase.Search
    this.payloadLength = -1
    this._result = null
  }

  push(samples: Float32Array): void {
    if (this.phase === Phase.Done || samples.length === 0) return
    this.append(samples)
    for (;;) {
      if (this.phase === Phase.Search) {
        if (!this.searchBlock()) break
      } else if (this.phase === Phase.Receive) {
        if (!this.receiveSymbol()) break
      } else break
    }
    this.compact()
  }

  // -- buffer --------------------------------------------------------------

  private append(samples: Float32Array): void {
    const need = this.bufLen + samples.length
    if (need > this.buf.length) {
      let cap = this.buf.length
      while (cap < need) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.buf.subarray(0, this.bufLen))
      this.buf = next
    }
    this.buf.set(samples, this.bufLen)
    this.bufLen = need
  }

  /** Drop samples nobody can need any more. */
  private compact(): void {
    let keepFrom: number
    if (this.phase === Phase.Search) {
      keepFrom = this.scanPos
    } else if (this.phase === Phase.Receive) {
      keepFrom = Math.floor(this.symbolStart(this.symbolIndex)) - Math.round(0.02 * this.fs)
      if (this.payloadLength < 0) keepFrom = Math.min(keepFrom, this.scanPos)
    } else {
      keepFrom = this.bufStart + this.bufLen
    }
    const drop = keepFrom - this.bufStart
    if (drop <= 0) return
    if (drop >= this.bufLen) {
      this.bufStart += this.bufLen
      this.bufLen = 0
      return
    }
    // Only move memory when it frees a meaningful share of the buffer.
    if (drop < this.buf.length / 4) return
    this.buf.copyWithin(0, drop, this.bufLen)
    this.bufStart += drop
    this.bufLen -= drop
  }

  private get bufEnd(): number {
    return this.bufStart + this.bufLen
  }

  // -- search --------------------------------------------------------------

  /** Correlate one overlap-save block. Returns false when more input is needed. */
  private searchBlock(): boolean {
    const N = FFT_SIZE
    if (this.scanPos < this.bufStart) this.scanPos = this.bufStart
    if (this.scanPos + N > this.bufEnd) return false
    const off = this.scanPos - this.bufStart
    const re = this.wre
    const im = this.wim
    const pre = this.prefix
    const buf = this.buf
    pre[0] = 0
    for (let i = 0; i < N; i++) {
      const v = buf[off + i]
      re[i] = v
      im[i] = 0
      pre[i + 1] = pre[i] + v * v
    }
    this.fft.run(re, im, false)
    const tr = this.tplRe
    const ti = this.tplIm
    for (let i = 0; i < N; i++) {
      // X · conj(T)
      const xr = re[i]
      const xi = im[i]
      re[i] = xr * tr[i] + xi * ti[i]
      im[i] = xi * tr[i] - xr * ti[i]
    }
    this.fft.run(re, im, true)
    const L = this.tplLen
    const norm = Math.SQRT2 / N
    const minEnergy = 1e-9 * L
    for (let j = 0; j < this.hop; j++) {
      const ex = pre[j + L] - pre[j]
      let score = 0
      if (ex > minEnergy) {
        const mag = Math.hypot(re[j], im[j]) * norm
        score = mag / Math.sqrt(ex * this.tplEnergy)
      }
      if (this.onScore(this.scanPos + j, score)) {
        // Locked: the rest of this block is no longer needed for searching.
        this.scanPos += j + 1
        return true
      }
    }
    this.scanPos += this.hop
    return true
  }

  /** Peak picking + pair check. Returns true when a chirp pair locked the decoder. */
  private onScore(n: number, score: number): boolean {
    let locked = false
    if (this.clusterActive) {
      if (n === this.clusterBest + 1) this.clusterNext = score
      if (n > this.clusterBest + PEAK_HOLD_SEC * this.fs) {
        locked = this.emitPeak()
        this.clusterActive = false
      }
    }
    if (!locked && score > DETECT_THRESHOLD) {
      if (!this.clusterActive || score > this.clusterBestScore) {
        this.clusterActive = true
        this.clusterBest = n
        this.clusterBestScore = score
        this.clusterPrev = this.prevScore
        this.clusterNext = 0
      }
    }
    this.prevScore = score
    return locked
  }

  private emitPeak(): boolean {
    const a = this.clusterPrev
    const b = this.clusterBestScore
    const c = this.clusterNext
    const den = a - 2 * b + c
    let delta = den < 0 ? (0.5 * (a - c)) / den : 0
    if (delta > 0.5) delta = 0.5
    if (delta < -0.5) delta = -0.5
    const peak: Peak = { t: this.clusterBest + delta, score: b }
    const spacing = CHIRP_SPACING_SEC * this.fs
    for (let i = this.peaks.length - 1; i >= 0; i--) {
      const p = this.peaks[i]
      const ratio = (peak.t - p.t) / spacing
      if (Math.abs(ratio - 1) <= RATIO_TOLERANCE && peak.score >= PAIR_MIN_RATIO * p.score) {
        this.lock(p.t, ratio)
        return true
      }
    }
    this.peaks.push(peak)
    // Keep only peaks that could still pair with a future one.
    const horizon = peak.t - spacing * (1 + RATIO_TOLERANCE) - 1
    while (this.peaks.length > 0 && (this.peaks[0].t < horizon || this.peaks.length > 8)) {
      this.peaks.shift()
    }
    return false
  }

  private lock(start: number, ratio: number): void {
    this.phase = Phase.Receive
    this.frameStart = start
    this.ratio = ratio
    this.symbolIndex = 0
    this.payloadLength = -1
    this.totalSymbols = HEADER_SYMBOLS
    this.track = 0
    this.peaks = []
    this.clusterActive = false
    for (let p = 0; p < 2; p++) {
      for (let v = 0; v < TONES_PER_SET; v++) {
        const f = toneFrequency(p, v) / ratio
        this.coeffs[p * TONES_PER_SET + v] = 2 * Math.cos((2 * Math.PI * f) / this.fs)
      }
    }
  }

  private unlock(skipTo: number): void {
    this.phase = Phase.Search
    this.payloadLength = -1
    if (skipTo > this.scanPos) this.scanPos = Math.floor(skipTo)
    this.prevScore = 0
    this.clusterActive = false
    this.peaks = []
  }

  // -- receive -------------------------------------------------------------

  private symbolStart(k: number): number {
    return this.frameStart + this.ratio * this.fs * (DATA_OFFSET_SEC + k * SYMBOL_SEC) + this.track
  }

  /** Load the Hann-windowed analysis segment starting at absolute sample `start`. */
  private loadSegment(start: number): void {
    const off = start - this.bufStart
    const seg = this.seg
    const hann = this.hann
    const buf = this.buf
    for (let i = 0; i < seg.length; i++) seg[i] = buf[off + i] * hann[i]
  }

  private goertzel(coeff: number): number {
    const seg = this.seg
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < seg.length; i++) {
      const s0 = seg[i] + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2
  }

  /** Demodulate the next symbol. Returns false when more input is needed. */
  private receiveSymbol(): boolean {
    const k = this.symbolIndex
    const delta = Math.round(TRACK_DELTA_SEC * this.fs)
    const base = Math.round(this.symbolStart(k) + WINDOW_START_SEC * this.ratio * this.fs)
    if (base - delta < this.bufStart) {
      // Samples already discarded (cannot normally happen) — give up on this frame.
      this.unlock(this.bufEnd)
      return true
    }
    if (base + delta + this.winLen > this.bufEnd) return false

    const set = (k & 1) * TONES_PER_SET
    this.loadSegment(base)
    let best = 0
    let bestPower = -1
    for (let v = 0; v < TONES_PER_SET; v++) {
      const p = this.goertzel(this.coeffs[set + v])
      if (p > bestPower) {
        bestPower = p
        best = v
      }
    }
    // Early/late gate on the chosen tone.
    const coeff = this.coeffs[set + best]
    this.loadSegment(base - delta)
    const early = this.goertzel(coeff)
    this.loadSegment(base + delta)
    const late = this.goertzel(coeff)
    const sum = early + late
    if (sum > 0) {
      const limit = TRACK_LIMIT_SEC * this.fs
      this.track += TRACK_GAIN * delta * ((late - early) / sum)
      if (this.track > limit) this.track = limit
      if (this.track < -limit) this.track = -limit
    }

    const byteIndex = k >> 1
    if (k & 1) this.coded[byteIndex] |= best
    else this.coded[byteIndex] = best << 4
    this.symbolIndex = k + 1

    if (this.symbolIndex === HEADER_SYMBOLS) return this.finishHeader()
    if (this.payloadLength >= 0 && this.symbolIndex === this.totalSymbols) return this.finishBody()
    return true
  }

  private finishHeader(): boolean {
    const decoded = rsDecode(this.coded.subarray(0, HEADER_DATA + HEADER_PARITY), HEADER_PARITY)
    if (!decoded || decoded.data[0] !== (HEADER_MAGIC | HEADER_VERSION)) {
      // False lock or unreadable header: resume searching where we left off.
      this.unlock(this.scanPos)
      return true
    }
    this.payloadLength = decoded.data[1]
    this.coded[0] = decoded.data[0]
    this.coded[1] = decoded.data[1]
    this.totalSymbols = HEADER_SYMBOLS + bodySymbols(this.payloadLength)
    // The header is genuine: nothing before the body needs to be searched again.
    this.scanPos = Math.max(this.scanPos, Math.floor(this.symbolStart(HEADER_SYMBOLS)))
    return true
  }

  private finishBody(): boolean {
    const len = this.payloadLength
    const headerBytes = HEADER_DATA + HEADER_PARITY
    const bodyLen = len + CRC_BYTES
    const coded = this.coded.subarray(headerBytes, headerBytes + codedLength(bodyLen))
    const body = decodeBlocks(coded, bodyLen)
    const frameEnd = this.symbolStart(this.totalSymbols)
    if (body) {
      const payload = body.data.slice(0, len)
      const d = body.data
      const got = ((d[len] << 24) | (d[len + 1] << 16) | (d[len + 2] << 8) | d[len + 3]) >>> 0
      if (got === crc32(frameHeader(len), payload)) {
        this._result = payload
        this.phase = Phase.Done
        this.bufStart += this.bufLen
        this.bufLen = 0
        return false
      }
    }
    this.unlock(frameEnd)
    return true
  }
}
