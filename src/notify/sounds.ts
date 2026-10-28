/*
 * Notification sounds, synthesized with WebAudio. No audio files: nothing to download, nothing
 * that can be swapped on the way, and the app stays one self-contained bundle.
 *
 * Each sound is a short score (well under a second and a half) played into a gain node. The
 * "voice" sounds are a small formant singer: a sawtooth with vibrato through three band-pass
 * filters tuned to the formants of a vowel, so "о-ла" glides from O to A like a sung syllable.
 *
 * Browsers start audio only after a user gesture: primeAudio() is called on the first tap or key
 * press, after that a sound can play when a message arrives, even with the tab in the background.
 */

export type SoundId = "seal" | "chime" | "drop" | "arp" | "voice-ola" | "voice-hey" | "choir" | "none";

/** Bulgarian source names (the UI translates them). Order = order in the settings list. */
export const SOUNDS: readonly { id: SoundId; name: string }[] = [
  { id: "seal", name: "Печат" },
  { id: "chime", name: "Звънче" },
  { id: "drop", name: "Капка" },
  { id: "arp", name: "Арпеж" },
  { id: "voice-ola", name: "Глас: „о-ла“" },
  { id: "voice-hey", name: "Глас: „хей“" },
  { id: "choir", name: "Хор" },
  { id: "none", name: "Без звук" },
];

export const DEFAULT_SOUND: SoundId = "seal";

export function isSoundId(v: unknown): v is SoundId {
  return typeof v === "string" && SOUNDS.some((s) => s.id === v);
}

/** The part of AudioContext the scores use, so tests can pass a recording fake. */
export type AudioLike = Pick<
  AudioContext,
  "currentTime" | "destination" | "createOscillator" | "createGain" | "createBiquadFilter" | "createBufferSource" | "createBuffer" | "sampleRate"
>;

type Vowel = readonly [number, number, number];
/** Formant centres (Hz) of a few vowels, adult voice. */
const VOWELS: Record<"o" | "a" | "e" | "aa", Vowel> = {
  o: [500, 850, 2500],
  a: [800, 1200, 2600],
  e: [450, 1900, 2600],
  aa: [700, 1100, 2550],
};
const FORMANT_GAIN = [1, 0.5, 0.18] as const;

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** A gain envelope: 0 -> peak in `attack`, then down to silence by `end`. */
function envelope(ctx: AudioLike, out: AudioNode, t0: number, attack: number, end: number, peak: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + end);
  g.connect(out);
  return g;
}

function tone(ctx: AudioLike, out: AudioNode, t0: number, hz: number, dur: number, peak: number, type: OscillatorType = "sine"): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, t0);
  o.connect(envelope(ctx, out, t0, 0.006, dur, peak));
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** A bell: a fundamental and two inharmonic partials that die away faster. */
function bell(ctx: AudioLike, out: AudioNode, t0: number, hz: number, dur: number, peak: number): void {
  tone(ctx, out, t0, hz, dur, peak);
  tone(ctx, out, t0, hz * 2.76, dur * 0.5, peak * 0.35);
  tone(ctx, out, t0, hz * 5.4, dur * 0.25, peak * 0.15);
}

/** One sung note: sawtooth + vibrato through three formant filters, gliding between vowels. */
function sing(ctx: AudioLike, out: AudioNode, t0: number, midi: number, dur: number, from: Vowel, to: Vowel, peak: number): void {
  const src = ctx.createOscillator();
  src.type = "sawtooth";
  const hz = midiHz(midi);
  src.frequency.setValueAtTime(hz * 0.97, t0);
  src.frequency.linearRampToValueAtTime(hz, t0 + 0.06); // a small scoop into the note, like a voice
  const vib = ctx.createOscillator();
  vib.frequency.setValueAtTime(5.5, t0);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t0);
  depth.gain.linearRampToValueAtTime(hz * 0.012, t0 + dur * 0.6);
  vib.connect(depth);
  depth.connect(src.frequency);
  const env = envelope(ctx, out, t0, 0.05, dur, peak);
  for (let i = 0; i < 3; i++) {
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.setValueAtTime(8 + i * 2, t0);
    f.frequency.setValueAtTime(from[i], t0);
    f.frequency.linearRampToValueAtTime(to[i], t0 + dur * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(FORMANT_GAIN[i] * 3, t0);
    src.connect(f);
    f.connect(g);
    g.connect(env);
  }
  src.start(t0);
  vib.start(t0);
  src.stop(t0 + dur + 0.05);
  vib.stop(t0 + dur + 0.05);
}

/** A short burst of filtered noise: breath, or the thump of a stamp. */
function noise(ctx: AudioLike, out: AudioNode, t0: number, dur: number, hz: number, peak: number): void {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647; // fixed sequence: the sound is the same every time
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.setValueAtTime(hz, t0);
  f.Q.setValueAtTime(1.2, t0);
  s.connect(f);
  f.connect(envelope(ctx, out, t0, 0.004, dur, peak));
  s.start(t0);
  s.stop(t0 + dur + 0.02);
}

/** Every sound as a score. Returns its length in seconds. */
export const SCORES: Record<Exclude<SoundId, "none">, (ctx: AudioLike, out: AudioNode, t0: number) => number> = {
  // the brand: a soft stamp into wax, then a clear ping
  seal(ctx, out, t0) {
    tone(ctx, out, t0, 110, 0.18, 0.6);
    noise(ctx, out, t0, 0.06, 900, 0.3);
    bell(ctx, out, t0 + 0.09, midiHz(88), 0.8, 0.28);
    return 0.9;
  },
  chime(ctx, out, t0) {
    bell(ctx, out, t0, midiHz(84), 0.7, 0.3);
    bell(ctx, out, t0 + 0.14, midiHz(91), 0.9, 0.26);
    return 1.05;
  },
  drop(ctx, out, t0) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(1400, t0);
    o.frequency.exponentialRampToValueAtTime(380, t0 + 0.16);
    o.connect(envelope(ctx, out, t0, 0.004, 0.22, 0.5));
    o.start(t0);
    o.stop(t0 + 0.25);
    tone(ctx, out, t0 + 0.12, 760, 0.18, 0.12);
    return 0.35;
  },
  arp(ctx, out, t0) {
    [76, 79, 83, 88].forEach((m, i) => tone(ctx, out, t0 + i * 0.075, midiHz(m), 0.32, 0.22, "triangle"));
    return 0.6;
  },
  // sung "о-ла": two syllables, a fifth apart, the vowel opening from O to A
  "voice-ola"(ctx, out, t0) {
    sing(ctx, out, t0, 67, 0.28, VOWELS.o, VOWELS.o, 0.45);
    sing(ctx, out, t0 + 0.27, 74, 0.5, VOWELS.o, VOWELS.a, 0.45);
    return 0.85;
  },
  // a breathy "хей": a puff of air, then a short E rising a little at the end
  "voice-hey"(ctx, out, t0) {
    noise(ctx, out, t0, 0.07, 2400, 0.18);
    sing(ctx, out, t0 + 0.05, 72, 0.36, VOWELS.e, VOWELS.e, 0.5);
    return 0.5;
  },
  // three voices on "аа", a major chord that blooms
  choir(ctx, out, t0) {
    [64, 68, 71].forEach((m, i) => sing(ctx, out, t0 + i * 0.03, m, 1.0, VOWELS.aa, VOWELS.aa, 0.22));
    return 1.15;
  },
};

let shared: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (shared) return shared;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    shared = null;
  }
  return shared;
}

/** Call from a user gesture: browsers keep audio locked until the first one. */
export function primeAudio(): void {
  const ctx = audioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
}

/**
 * Plays a sound at `volume` (0..1). Returns false when nothing could play (no audio support,
 * "none", or audio still locked because there was no user gesture yet).
 */
export function playSound(id: SoundId, volume = 0.7, ctx: AudioLike | null = audioContext()): boolean {
  if (id === "none" || !ctx || volume <= 0) return false;
  const real = ctx as Partial<AudioContext>;
  if (real.state === "suspended") void real.resume?.().catch(() => undefined);
  if (real.state === "closed") return false;
  const master = ctx.createGain();
  master.gain.setValueAtTime(Math.min(1, volume), ctx.currentTime);
  master.connect(ctx.destination);
  SCORES[id](ctx, master, ctx.currentTime + 0.02);
  return true;
}
