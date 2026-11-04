/**
 * Soundtrack synthesised with ffmpeg only (lavfi sine sources): a soft pad + arpeggio bed in A minor,
 * short UI blips at scene changes and a multi-tone "chirp" motif for the sound-pairing scene.
 * Returns { inputs, script } for ffmpeg -filter_complex_script; output label [out].
 */
import { TIMELINE as T } from "./scene.html.js";

const note = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz
const CH = [ // Am F C G Am F (MIDI), each 7.25 s
  [57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65],
];
const SEG = T.total / CH.length;

export function buildAudioScript() {
  const lines = [];
  const outs = [];
  let n = 0;
  const add = (freq, start, dur, vol, fi = 0.01, fo = dur * 0.8, curve = "tri") => {
    const id = `s${n++}`;
    const st = Math.max(0, start);
    lines.push(`sine=frequency=${freq.toFixed(2)}:sample_rate=44100:duration=${dur.toFixed(3)},afade=t=in:st=0:d=${fi.toFixed(3)},afade=t=out:st=${Math.max(0, dur - fo).toFixed(3)}:d=${fo.toFixed(3)}:curve=${curve},volume=${vol},adelay=${Math.round(st * 1000)}:all=1[${id}]`);
    outs.push(`[${id}]`);
  };
  // pad: root + fifth + tenth, detuned pairs for width; chord overlaps neighbours
  CH.forEach((c, i) => {
    const s0 = i * SEG - 0.8, d = SEG + 1.6;
    [c[0] - 12, c[1] - 12, c[2] - 12].forEach((m) => {
      add(note(m), s0, d, 0.05, 1.4, 1.4, "qsin");
      add(note(m) * 1.004, s0, d, 0.03, 1.4, 1.4, "qsin");
    });
  });
  // arpeggio: quarter notes at 120 bpm walking the chord tones
  const pat = [0, 1, 2, 3, 2, 1];
  for (let k = 0, tt = 0.25; tt < T.total - 1.5; k++, tt += 0.5) {
    const c = CH[Math.min(CH.length - 1, Math.floor(tt / SEG))];
    add(note(c[pat[k % pat.length]] + 12), tt, 1.1, 0.075, 0.012, 1.0, "exp");
  }
  // UI blips at scene changes
  const blip = (t, up = true, v = 0.11) => {
    const [f1, f2] = up ? [1046.5, 1568] : [1568, 1046.5];
    add(f1, t, 0.12, v, 0.004, 0.1, "exp"); add(f2, t + 0.07, 0.2, v, 0.004, 0.18, "exp");
  };
  ["title", "a", "b", "c", "d", "e", "f", "words", "end"].forEach((k) => blip(T[k] + 0.05));
  // cues inside scenes
  blip(T.hook + 3.6, true, 0.08); // two phones link up
  blip(T.a + 3.55, true, 0.08);
  add(880, T.b + 2.95, 0.15, 0.12, 0.004, 0.14, "exp"); add(330, T.b + 3.0, 0.25, 0.12, 0.004, 0.22, "exp"); // lock click
  blip(T.c + 2.6, true, 0.08);
  blip(T.d + 1.72, true, 0.08);
  // chirp motif: scene d, sound travelling from the second phone, then a short answering chime
  [1318.5, 1568, 2093, 1568, 2637, 2093, 3136].forEach((f, i) => add(f, T.d + 1.95 + i * 0.1, 0.14, 0.14, 0.004, 0.12, "exp"));
  [1318.5, 1568, 2093, 1568, 2637, 2093, 3136].forEach((f, i) => add(f, T.d + 2.75 + i * 0.1, 0.14, 0.07, 0.004, 0.12, "exp"));
  [2093, 1568, 1318.5].forEach((f, i) => add(f, T.d + 3.5 + i * 0.12, 0.2, 0.12, 0.004, 0.18, "exp"));
  blip(T.d + 4.0, true, 0.1);
  blip(T.e + 3.2, true, 0.08);
  blip(T.f + 1.95, true, 0.08);
  blip(T.f + 3.0, true, 0.08);
  [1046.5, 1318.5, 1568].forEach((f) => add(f, T.words + 3.7, 1.2, 0.07, 0.01, 1.1, "exp")); // seal stamp chord
  // end swell
  [note(57), note(64), note(69), note(73)].forEach((f) => add(f, T.end + 0.2, 4.6, 0.045, 0.6, 2.2, "qsin"));
  lines.push(`${outs.join("")}amix=inputs=${outs.length}:normalize=0:duration=longest,atrim=0:${T.total},lowpass=f=5200,aecho=0.7:0.5:90|170:0.25|0.15,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.3,afade=t=out:st=${T.total - 1.6}:d=1.6,loudnorm=I=-16:TP=-1.5:LRA=7[out]`);
  return lines.join(";\n");
}
