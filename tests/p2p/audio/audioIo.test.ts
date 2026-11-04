import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAudioPairingSupported, playSamples, startListening } from '../../../src/p2p/audio/audioIo'

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
}
class FakeSource extends FakeNode {
  buffer: unknown = null
  onended: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onended?.())
}
class FakeContext {
  static instances: FakeContext[] = []
  sampleRate = 44100
  state = 'running'
  destination = new FakeNode()
  audioWorklet = undefined
  source = new FakeSource()
  processor: (FakeNode & { onaudioprocess: ((e: unknown) => void) | null }) | null = null
  close = vi.fn(async () => {
    this.state = 'closed'
  })
  resume = vi.fn(async () => undefined)
  constructor() {
    FakeContext.instances.push(this)
  }
  createBuffer(_c: number, len: number) {
    const data = new Float32Array(len)
    return { getChannelData: () => data }
  }
  createBufferSource() {
    return this.source
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } })
  }
  createMediaStreamSource() {
    return new FakeNode()
  }
  createScriptProcessor() {
    this.processor = Object.assign(new FakeNode(), { onaudioprocess: null })
    return this.processor
  }
}

function fakeStream() {
  const tracks = [{ stop: vi.fn() }]
  return { tracks, stream: { getTracks: () => tracks } }
}

let g: { stream: ReturnType<typeof fakeStream>; getUserMedia: ReturnType<typeof vi.fn> }

beforeEach(() => {
  FakeContext.instances = []
  vi.stubGlobal('AudioContext', FakeContext)
  const stream = fakeStream()
  const getUserMedia = vi.fn(async () => stream.stream)
  g = { stream, getUserMedia }
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('audioIo', () => {
  it('reports support only with Web Audio and getUserMedia', () => {
    expect(isAudioPairingSupported()).toBe(true)
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    expect(isAudioPairingSupported()).toBe(false)
  })

  it('playSamples resolves on end and closes its own context', async () => {
    const p = playSamples(new Float32Array(10))
    await vi.waitFor(() => expect(FakeContext.instances[0]?.source.start).toHaveBeenCalled())
    const ctx = FakeContext.instances[0]
    ctx.source.onended?.()
    await p
    expect(ctx.close).toHaveBeenCalled()
  })

  it('playSamples aborts: stops the source, rejects AbortError, keeps a passed-in context', async () => {
    const ctx = new FakeContext()
    const ac = new AbortController()
    const p = playSamples(new Float32Array(10), {
      signal: ac.signal,
      audioContext: ctx as unknown as AudioContext,
    })
    await vi.waitFor(() => expect(ctx.source.start).toHaveBeenCalled())
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(ctx.source.stop).toHaveBeenCalled()
    expect(ctx.close).not.toHaveBeenCalled()
    await expect(playSamples(new Float32Array(1), { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('startListening disables voice processing, delivers chunks and stops tracks', async () => {
    const chunks: number[] = []
    const h = await startListening((s, rate) => chunks.push(s.length, rate))
    expect(g.getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    })
    expect(h.sampleRate).toBe(44100)
    const ctx = FakeContext.instances[0]
    ctx.processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4) } })
    expect(chunks).toEqual([4, 44100])
    h.stop()
    h.stop()
    expect(g.stream.tracks[0].stop).toHaveBeenCalledTimes(1)
    expect(ctx.close).toHaveBeenCalledTimes(1)
    ctx.processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4) } })
    expect(chunks).toHaveLength(2)
  })

  it('startListening stops everything when the signal aborts', async () => {
    const ac = new AbortController()
    await startListening(() => undefined, { signal: ac.signal })
    ac.abort()
    expect(g.stream.tracks[0].stop).toHaveBeenCalled()
    expect(FakeContext.instances[0].close).toHaveBeenCalled()
  })

  it('startListening aborted while waiting for permission releases the mic', async () => {
    const ac = new AbortController()
    g.getUserMedia.mockImplementation(async () => {
      ac.abort()
      return g.stream.stream
    })
    await expect(startListening(() => undefined, { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(g.stream.tracks[0].stop).toHaveBeenCalled()
    expect(FakeContext.instances).toHaveLength(0)
  })
})
