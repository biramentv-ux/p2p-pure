// @vitest-environment node
/**
 * Н8: recorded fixtures for the sound and light modems. Every release decodes the same captures,
 * so a change to either modem cannot quietly lose what used to work.
 *
 * The files in this folder are either real recordings (imported with
 * `node scripts/natlab/import-recording.mjs`) or synthetic captures made through the same
 * distortions the unit tests use (noise, echo, clock drift, perspective, blur, white balance).
 * manifest.json says which, and what payload each must give back.
 *
 *   UPDATE_MODEM_FIXTURES=1 npx vitest run tests/fixtures/modem   # re-make the synthetic ones
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { encodeToSamples, FskDecoder } from "../../../src/p2p/audio/fskModem";
import { encodeLightFrames, LIGHT_SYMBOL_UNITS, LightDecoder, rasterizeFrame } from "../../../src/p2p/light/lightCodec";
import { addEcho, addNoise, pad, randomBytes, resample, wobbleGain } from "../../p2p/audio/helpers";
import { blur, camera, tiltCorners, Warper } from "../../p2p/light/helpers";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const MANIFEST = path.join(DIR, "manifest.json");

interface Entry {
  file: string;
  kind: "sound" | "light";
  source: "synthetic" | "recording";
  description: string;
  payloadHex: string;
  sampleRate?: number;
  width?: number;
  height?: number;
}

// ---- WAV (mono 16-bit PCM) ----
export function writeWav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function readWav(buf: Buffer): { rate: number; samples: Float32Array } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let o = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (o + 8 <= buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(o + 10);
      rate = buf.readUInt32LE(o + 12);
      bits = buf.readUInt16LE(o + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit PCM");
      const n = Math.floor(len / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(o + 8 + i * 2 * channels) / 32768; // first channel
      return { rate, samples: out };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error("no data chunk");
}

// ---- Light captures: gzip of [u32 width][u32 height][u32 count] + count × RGBA frames ----
export function writeFrames(frames: Uint8ClampedArray[], w: number, h: number): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(w, 0);
  head.writeUInt32LE(h, 4);
  head.writeUInt32LE(frames.length, 8);
  return zlib.gzipSync(Buffer.concat([head, ...frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))]), { level: 9 });
}

export function readFrames(buf: Buffer): { width: number; height: number; frames: Uint8ClampedArray[] } {
  const raw = zlib.gunzipSync(buf);
  const width = raw.readUInt32LE(0);
  const height = raw.readUInt32LE(4);
  const count = raw.readUInt32LE(8);
  const size = width * height * 4;
  const frames = Array.from({ length: count }, (_, i) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + 12 + i * size, size));
  return { width, height, frames };
}

// ---- The synthetic set ----
function makeSynthetic(): Entry[] {
  const entries: Entry[] = [];
  const add = (e: Entry, content: Buffer) => {
    fs.writeFileSync(path.join(DIR, e.file), content);
    entries.push(e);
  };
  // Kept small for the repository: 120-byte payloads (a compact answer is 150–200), sound at
  // 16–22 kHz (the modem's tones stop at 5.5 kHz), light at 200×150 to 256×192.
  const sounds: Array<[string, string, number, (x: Float32Array) => Float32Array]> = [
    ["sound-quiet-room.wav", "quiet room, 16 kHz, SNR 30 dB", 16000, (x) => addNoise(pad(resample(x, 48000, 16000), 800, 800, 0.002, 1), 30, 2)],
    ["sound-office-echo.wav", "office: echo 18 ms × 0.35, SNR 18 dB, 22.05 kHz with +80 ppm drift", 22050, (x) => addNoise(addEcho(pad(resample(x, 48000, 22050, 80e-6), 2000, 2000, 0.004, 3), 397, 0.35), 18, 4)],
    ["sound-phone-speaker.wav", "phone speaker: gain wobble 30%, SNR 14 dB, 16 kHz", 16000, (x) => addNoise(wobbleGain(pad(resample(x, 48000, 16000), 1000, 1000, 0.003, 5), 3000, 0.3, 6), 14, 7)],
  ];
  sounds.forEach(([file, description, rate, distort], i) => {
    const payload = randomBytes(120, 100 + i);
    const clean = encodeToSamples(payload, 48000);
    add({ file, kind: "sound", source: "synthetic", description, payloadHex: Buffer.from(payload).toString("hex"), sampleRate: rate }, writeWav(distort(clean), rate));
  });
  const SRC = LIGHT_SYMBOL_UNITS * 10;
  const lights: Array<[string, string, [number, number, number], number, number, [number, number, number], number, number]> = [
    ["light-desk-tilt.rgba.gz", "256×192, tilt 18°/−12°, noise σ 4", [18, -12, 4], 0, 4, [1, 1, 1], 256, 192],
    ["light-dim-warm.rgba.gz", "200×150, dim warm light, tilt −10°/14°, noise σ 3", [-10, 14, -3], 0, 3, [0.55, 0.5, 0.36], 200, 150],
  ];
  lights.forEach(([file, description, tilt, blurR, sigma, gain, w, h], i) => {
    const payload = randomBytes(120, 200 + i);
    const warper = new Warper(SRC, w, h, tiltCorners(w, h, ...tilt, 0.85), 50 + i);
    const frames = encodeLightFrames(payload).map((f, k) => {
      let img = warper.apply(rasterizeFrame(f, SRC, SRC));
      if (blurR) img = blur(img, w, h, blurR);
      return camera(img, gain, sigma, 900 + i * 50 + k);
    });
    add({ file, kind: "light", source: "synthetic", description, payloadHex: Buffer.from(payload).toString("hex"), width: w, height: h }, writeFrames(frames, w, h));
  });
  return entries;
}

if (process.env.UPDATE_MODEM_FIXTURES === "1") {
  const old: Entry[] = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : [];
  const recordings = old.filter((e) => e.source === "recording");
  fs.writeFileSync(MANIFEST, JSON.stringify([...makeSynthetic(), ...recordings], null, 2) + "\n");
}

const entries: Entry[] = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

describe("Н8 modem fixtures (every release decodes the same captures)", () => {
  for (const e of entries) {
    it(`${e.kind}: ${e.file} — ${e.description} (${e.source})`, () => {
      const buf = fs.readFileSync(path.join(DIR, e.file));
      const want = Uint8Array.from(Buffer.from(e.payloadHex, "hex"));
      if (e.kind === "sound") {
        const { rate, samples } = readWav(buf);
        const dec = new FskDecoder(rate);
        for (let i = 0; i < samples.length; i += 4096) dec.push(samples.subarray(i, i + 4096));
        expect(dec.result).toEqual(want);
      } else {
        const { width, height, frames } = readFrames(buf);
        const dec = new LightDecoder();
        // Loop the capture like a camera that joins mid-way: start in the middle.
        const start = Math.floor(frames.length / 2);
        for (let k = 0; k < frames.length * 2 && !dec.result; k++) dec.push({ data: frames[(start + k) % frames.length], width, height });
        expect(dec.result).toEqual(want);
      }
    });
  }

  it("has sound and light captures", () => {
    expect(entries.some((e) => e.kind === "sound")).toBe(true);
    expect(entries.some((e) => e.kind === "light")).toBe(true);
  });
});
