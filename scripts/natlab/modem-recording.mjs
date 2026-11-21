/**
 * Н8: real recordings for the modem fixtures (tests/fixtures/modem).
 *
 *   1. Make the test signal (a fixed 120-byte payload) as a sound file and as a light video:
 *        node scripts/natlab/modem-recording.mjs signal  → modem-signal/{signal.wav, signal.mp4}
 *      Play signal.wav on one phone's speaker, signal.mp4 full screen on its display.
 *   2. Record with another phone (voice memo; camera video ~30 cm away, symbol filling the frame).
 *   3. Import each recording (ffmpeg converts it):
 *        node scripts/natlab/modem-recording.mjs import --sound memo.m4a --note "Pixel 8 → iPhone 15, kitchen"
 *        node scripts/natlab/modem-recording.mjs import --light clip.mp4 --note "Galaxy A52 camera, desk lamp"
 *      It writes the file next to the synthetic ones and adds it to manifest.json as a
 *      "recording", with the test payload as the expected result. `npx vitest run tests/fixtures/modem`
 *      then checks it on every release.
 *
 * The modem code is TypeScript: it is loaded through Vite (already a dev dependency). ffmpeg
 * must be on PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const vite = await createServer({ root: ROOT, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { encodeToSamples } = await vite.ssrLoadModule("/src/p2p/audio/fskModem.ts");
const { encodeLightFrames, LIGHT_FPS, LIGHT_SYMBOL_UNITS, rasterizeFrame } = await vite.ssrLoadModule("/src/p2p/light/lightCodec.ts");
const FIXTURES = path.join(ROOT, "tests/fixtures/modem");
/** The test payload every real recording carries: bytes 0..119 xor 0x5a, easy to recognise. */
export const TEST_PAYLOAD = Uint8Array.from({ length: 120 }, (_, i) => i ^ 0x5a);

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error("ffmpeg failed (is it installed?)");
  return r.stdout;
}

function wav16(samples, rate) {
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

function signal(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Sound: the transmission three times with 1.5 s of silence, so a late start still catches one.
  const one = encodeToSamples(TEST_PAYLOAD, 48000);
  const gap = new Float32Array(72000);
  const all = new Float32Array(one.length * 3 + gap.length * 3);
  for (let k = 0; k < 3; k++) {
    all.set(gap, k * (one.length + gap.length));
    all.set(one, k * (one.length + gap.length) + gap.length);
  }
  fs.writeFileSync(path.join(outDir, "signal.wav"), wav16(all, 48000));
  // Light: the frames at the app's rate, looped for ~20 s, white margin like the app's screen.
  const size = LIGHT_SYMBOL_UNITS * 30;
  const frames = encodeLightFrames(TEST_PAYLOAD).map((f) => Buffer.from(rasterizeFrame(f, size, size)));
  const loops = Math.max(1, Math.ceil((20 * LIGHT_FPS) / frames.length));
  const raw = Buffer.concat(Array.from({ length: loops }, () => frames).flat());
  const input = path.join(outDir, "frames.rgba");
  fs.writeFileSync(input, raw);
  ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${size}x${size}`, "-r", String(LIGHT_FPS), "-i", input, "-vf", "pad=iw+120:ih+120:60:60:white", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", path.join(outDir, "signal.mp4")]);
  fs.rmSync(input);
  console.log(`Wrote ${outDir}/signal.wav and signal.mp4 (payload: ${Buffer.from(TEST_PAYLOAD).toString("hex").slice(0, 16)}…)`);
}

function addToManifest(entry) {
  const file = path.join(FIXTURES, "manifest.json");
  const list = JSON.parse(fs.readFileSync(file, "utf8")).filter((e) => e.file !== entry.file);
  list.push(entry);
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
}

function importSound(src, note) {
  const name = `rec-sound-${Date.now()}.wav`;
  // Mono, 22.05 kHz, 16-bit: enough for tones up to 5.5 kHz, small in the repository.
  ffmpeg(["-i", src, "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", path.join(FIXTURES, name)]);
  addToManifest({ file: name, kind: "sound", source: "recording", description: note, payloadHex: Buffer.from(TEST_PAYLOAD).toString("hex"), sampleRate: 22050 });
  console.log(`Added ${name}`);
}

function importLight(src, note) {
  const name = `rec-light-${Date.now()}.rgba.gz`;
  const w = 320;
  const h = 240;
  // 10 frames a second is enough to catch every 3 fps symbol at least twice.
  const raw = ffmpeg(["-i", src, "-vf", `fps=10,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  const count = Math.floor(raw.length / (w * h * 4));
  const head = Buffer.alloc(12);
  head.writeUInt32LE(w, 0);
  head.writeUInt32LE(h, 4);
  head.writeUInt32LE(count, 8);
  fs.writeFileSync(path.join(FIXTURES, name), zlib.gzipSync(Buffer.concat([head, raw.subarray(0, count * w * h * 4)]), { level: 9 }));
  addToManifest({ file: name, kind: "light", source: "recording", description: note, payloadHex: Buffer.from(TEST_PAYLOAD).toString("hex"), width: w, height: h });
  console.log(`Added ${name} (${count} frames)`);
}

const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (argv[0] === "signal") signal(path.resolve(opt("--out") ?? "modem-signal"));
else if (argv[0] === "import") {
  const note = opt("--note") ?? "real recording";
  if (opt("--sound")) importSound(path.resolve(opt("--sound")), note);
  if (opt("--light")) importLight(path.resolve(opt("--light")), note);
} else console.log("Usage: modem-recording.mjs signal [--out dir] | import --sound file | --light file [--note text]");
await vite.close();
