/**
 * Thin browser adapters for the audio modem: speaker playback and raw microphone capture.
 *
 * iOS / Safari: an AudioContext only starts producing sound when it is created or
 * resumed inside a user gesture (tap/click handler). Call {@link playSamples} directly
 * from the gesture handler (or pass an `audioContext` that was created/resumed there),
 * otherwise playback stays silent. The same holds for {@link startListening} on iOS:
 * start it from the tap that opens the "listen" screen.
 *
 * Microphone capture asks for echo cancellation, noise suppression and auto gain OFF —
 * all three distort FSK tones. Samples arrive through an AudioWorklet (inline Blob
 * module, so no extra file and no CSP change beyond `blob:` for worklets) when the
 * browser supports it, otherwise through the deprecated ScriptProcessorNode.
 */

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return g.AudioContext ?? g.webkitAudioContext ?? null
}

/** True when this browser can both play generated audio and capture the microphone. */
export function isAudioPairingSupported(): boolean {
  if (!audioContextCtor()) return false
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices
  return typeof md?.getUserMedia === 'function'
}

function abortError(): Error {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Play `samples` through the speaker. Resolves when playback finished, rejects with an
 * `AbortError` when `signal` aborts (playback stops immediately). A context passed in
 * `audioContext` is left open; one created here is closed afterwards.
 * Must be called from a user gesture on iOS (see module comment).
 */
export async function playSamples(
  samples: Float32Array,
  opts: { sampleRate?: number; signal?: AbortSignal; audioContext?: AudioContext } = {},
): Promise<void> {
  const { signal } = opts
  if (signal?.aborted) throw abortError()
  let ctx = opts.audioContext
  const owned = !ctx
  if (!ctx) {
    const Ctor = audioContextCtor()
    if (!Ctor) throw new Error('Web Audio is not available')
    ctx = new Ctor()
  }
  const context = ctx
  try {
    if (context.state === 'suspended') await context.resume()
    const rate = opts.sampleRate ?? context.sampleRate
    const buffer = context.createBuffer(1, samples.length, rate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        source.onended = null
        try {
          source.stop()
        } catch {
          // already stopped
        }
        reject(abortError())
      }
      source.onended = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      source.start()
    })
    source.disconnect()
  } finally {
    if (owned) await context.close().catch(() => undefined)
  }
}

const WORKLET_SOURCE = `
class ModemTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('modem-tap', ModemTap);
`

/**
 * Open the microphone with all voice processing disabled and stream mono Float32
 * chunks to `onChunk`. `stop()` (or aborting `signal`) disconnects the graph, stops
 * every media track and closes the context; it is idempotent.
 */
export async function startListening(
  onChunk: (samples: Float32Array, sampleRate: number) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<{ stop(): void; sampleRate: number }> {
  const { signal } = opts
  if (signal?.aborted) throw abortError()
  const Ctor = audioContextCtor()
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices
  if (!Ctor || !md?.getUserMedia) throw new Error('Microphone capture is not available')

  const stream = await md.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  })
  const stopTracks = () => {
    for (const t of stream.getTracks()) t.stop()
  }
  if (signal?.aborted) {
    stopTracks()
    throw abortError()
  }

  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch (e) {
    stopTracks()
    throw e
  }
  const sampleRate = ctx.sampleRate
  let stopped = false
  const nodes: AudioNode[] = []
  let blobUrl: string | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    signal?.removeEventListener('abort', stop)
    for (const n of nodes) {
      try {
        n.disconnect()
      } catch {
        // not connected
      }
    }
    stopTracks()
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    void ctx.close().catch(() => undefined)
  }
  signal?.addEventListener('abort', stop, { once: true })

  try {
    if (ctx.state === 'suspended') await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    nodes.push(source)
    // A muted sink keeps the graph pulled on every browser without echoing the mic.
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    nodes.push(sink)

    let viaWorklet = false
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
        await ctx.audioWorklet.addModule(blobUrl)
        const node = new AudioWorkletNode(ctx, 'modem-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
        })
        node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
          if (!stopped) onChunk(ev.data, sampleRate)
        }
        source.connect(node)
        node.connect(sink)
        nodes.push(node)
        viaWorklet = true
      } catch {
        // Worklet blocked (CSP, old WebKit): fall back below.
      }
    }
    if (!viaWorklet) {
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      proc.onaudioprocess = (ev: AudioProcessingEvent) => {
        if (!stopped) onChunk(ev.inputBuffer.getChannelData(0).slice(0), sampleRate)
      }
      source.connect(proc)
      proc.connect(sink)
      nodes.push(proc)
    }
  } catch (e) {
    stop()
    throw e
  }
  if (stopped) throw abortError()
  return { stop, sampleRate }
}
