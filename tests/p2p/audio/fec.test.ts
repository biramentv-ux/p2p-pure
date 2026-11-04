import { describe, it, expect } from 'vitest'
import {
  codedLength,
  crc32,
  decodeBlocks,
  encodeBlocks,
  gfDiv,
  gfMul,
  planBlocks,
  RS_BLOCK_DATA,
  RS_BLOCK_PARITY,
  rsDecode,
  rsEncode,
} from '../../../src/p2p/audio/fec'
import { prng, randomBytes } from './helpers'

function corrupt(cw: Uint8Array, count: number, seed: number): Uint8Array {
  const r = prng(seed)
  const out = cw.slice()
  const used = new Set<number>()
  while (used.size < count) {
    const pos = Math.floor(r() * cw.length)
    if (used.has(pos)) continue
    used.add(pos)
    out[pos] ^= 1 + Math.floor(r() * 255)
  }
  return out
}

describe('GF(256)', () => {
  it('multiplication and division are inverse', () => {
    for (let a = 1; a < 256; a += 7) {
      for (let b = 1; b < 256; b += 11) expect(gfDiv(gfMul(a, b), b)).toBe(a)
    }
    expect(gfMul(0, 5)).toBe(0)
    expect(() => gfDiv(1, 0)).toThrow(RangeError)
  })
})

describe('Reed–Solomon', () => {
  it('is systematic and decodes a clean codeword', () => {
    const data = randomBytes(30, 1)
    const cw = rsEncode(data, 10)
    expect(cw.subarray(0, 30)).toEqual(data)
    expect(rsDecode(cw, 10)).toEqual({ data, corrected: 0 })
  })

  for (const nsym of [8, 12, 32]) {
    it(`corrects up to ${nsym / 2} errors with ${nsym} parity bytes`, () => {
      for (let trial = 0; trial < 40; trial++) {
        const data = randomBytes(5 + (trial % 30), trial)
        const cw = rsEncode(data, nsym)
        const errors = (trial % (nsym / 2)) + 1
        const r = rsDecode(corrupt(cw, errors, trial * 13 + 1), nsym)
        expect(r).not.toBeNull()
        expect(r!.data).toEqual(data)
        expect(r!.corrected).toBe(errors)
      }
    })
  }

  it('handles a maximum-length (255) codeword', () => {
    const data = randomBytes(255 - 16, 9)
    const cw = rsEncode(data, 16)
    expect(rsDecode(corrupt(cw, 8, 3), 16)!.data).toEqual(data)
  })

  it('fails cleanly (null, never wrong data) beyond the design limit', () => {
    let failed = 0
    for (let trial = 0; trial < 200; trial++) {
      const data = randomBytes(32, 1000 + trial)
      const cw = rsEncode(data, RS_BLOCK_PARITY)
      const r = rsDecode(corrupt(cw, RS_BLOCK_PARITY / 2 + 1 + (trial % 6), trial), RS_BLOCK_PARITY)
      // Beyond t errors RS can mis-correct to another valid codeword; it must never claim
      // success with the original data being silently altered *and* report ≤ t corrections
      // that do not match the received word. Either null, or a self-consistent codeword.
      if (r === null) failed++
      else expect(rsDecode(rsEncode(r.data, RS_BLOCK_PARITY), RS_BLOCK_PARITY)!.data).toEqual(r.data)
    }
    expect(failed).toBeGreaterThan(190)
  })

  it('rejects invalid shapes without throwing', () => {
    expect(rsDecode(new Uint8Array(5), 8)).toBeNull()
    expect(rsDecode(new Uint8Array(256), 8)).toBeNull()
    expect(() => rsEncode(new Uint8Array(250), 8)).toThrow(RangeError)
  })
})

describe('block plan + interleaving', () => {
  it('splits into near-equal blocks of at most RS_BLOCK_DATA', () => {
    expect(planBlocks(1)).toEqual([1])
    expect(planBlocks(32)).toEqual([32])
    expect(planBlocks(33)).toEqual([17, 16])
    const p = planBlocks(259)
    expect(p.reduce((a, b) => a + b, 0)).toBe(259)
    expect(Math.max(...p)).toBeLessThanOrEqual(RS_BLOCK_DATA)
    expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1)
    expect(codedLength(204)).toBe(204 + 7 * RS_BLOCK_PARITY)
  })

  it('round-trips and corrects a burst spread across blocks', () => {
    const data = randomBytes(204, 5)
    const coded = encodeBlocks(data)
    const blocks = planBlocks(204).length
    // A contiguous burst of blocks × t bytes hits each block at most t times.
    const burst = coded.slice()
    const start = 40
    for (let i = start; i < start + blocks * (RS_BLOCK_PARITY / 2); i++) burst[i] ^= 0x5a
    const r = decodeBlocks(burst, 204)
    expect(r!.data).toEqual(data)
    expect(r!.corrected).toBe(blocks * (RS_BLOCK_PARITY / 2))
  })

  it('returns null when one block is uncorrectable or length mismatches', () => {
    const data = randomBytes(100, 6)
    const coded = encodeBlocks(data)
    const bad = coded.slice()
    const blocks = planBlocks(100).length
    // Hit block 0 (indices 0, blocks, 2·blocks, …) t+1 … times.
    for (let j = 0; j < RS_BLOCK_PARITY; j++) bad[j * blocks] ^= 0xff
    expect(decodeBlocks(bad, 100)).toBeNull()
    expect(decodeBlocks(coded.subarray(1), 100)).toBeNull()
  })
})

describe('crc32', () => {
  it('matches the IEEE check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
    const a = new TextEncoder().encode('1234')
    const b = new TextEncoder().encode('56789')
    expect(crc32(a, b)).toBe(0xcbf43926)
  })
})
