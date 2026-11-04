/**
 * Rebuilds the promo videos (docs/public/assets/promo-{bg,en}.mp4 and .gif): ~43 s, 1280x720, 30 fps,
 * H.264 + AAC, with a soundtrack synthesised by ffmpeg. Scenes are HTML animated by a JS clock and captured
 * frame by frame with Playwright (deterministic). The safety words are the real ones from src/p2p/safety.ts.
 *   node scripts/docs/promo-video.mjs            (needs playwright-core, vite, ffmpeg)
 * Env: CHROME_PATH, OUT_DIR, LANGS=bg,en, WORK_DIR, FRAME_STEP (debug: render every Nth frame only).
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { html, TIMELINE } from "./promo/scene.html.js";
import { buildAudioScript } from "./promo/audio.mjs";

const root = resolve(import.meta.dirname, "../..");
const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const OUT_DIR = process.env.OUT_DIR ?? join(root, "docs/public/assets");
const WORK = process.env.WORK_DIR ?? "/tmp/promo-work";
const LANGS = (process.env.LANGS ?? "bg,en").split(",").map((s) => s.trim()).filter(Boolean);
const FPS = 30;
const FRAMES = Math.round(TIMELINE.total * FPS);
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// Real safety words from the real function (the same two demo keys as the tutorial GIF).
const vite = await createServer({ root, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const safety = await vite.ssrLoadModule("/src/p2p/safety.ts");
const ka = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const kb = Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 3) & 255);
const words = safety.safetyWords(ka, kb);
await vite.close();
if (words.length !== 12) throw new Error("expected 12 safety words");

// IBM Plex from node_modules, referenced by file:// URL.
const face = (dir, name, w, sub, range) =>
  `@font-face{font-family:'${name}';font-weight:${w};font-display:block;src:url('${pathToFileURL(join(root, `node_modules/@fontsource/${dir}/files/${dir}-${sub}-${w}-normal.woff2`))}') format('woff2');unicode-range:${range}}`;
const CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const LAT = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const fam = (dir, name, ws) => ws.flatMap((w) => [face(dir, name, w, "cyrillic", CYR), face(dir, name, w, "latin", LAT)]);
const fonts = [...fam("ibm-plex-serif", "Plex Serif", ["500"]), ...fam("ibm-plex-sans", "Plex Sans", ["400", "600"]), ...fam("ibm-plex-mono", "Plex Mono", ["500"])].join("\n");

// Soundtrack (shared by both languages: same timeline).
const audioWav = join(WORK, "soundtrack.m4a");
writeFileSync(join(WORK, "audio.filter"), buildAudioScript());
execFileSync("ffmpeg", ["-v", "error", "-y", "-filter_complex_script", join(WORK, "audio.filter"), "-map", "[out]", "-c:a", "aac", "-b:a", "160k", audioWav], { stdio: "inherit" });

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files", "--force-color-profile=srgb"] });

async function build(lang) {
  const file = join(WORK, `scene-${lang}.html`);
  writeFileSync(file, html(lang, { fonts, words }));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: lang === "bg" ? "bg-BG" : "en-GB" });
  const pg = await ctx.newPage();
  await pg.goto(pathToFileURL(file).href);
  await pg.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))); await document.fonts.ready; });
  const video = join(WORK, `video-${lang}.mp4`);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-i", audioWav, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-vf", "format=yuv420p", "-r", String(FPS), "-c:a", "copy", "-movflags", "+faststart", "-shortest", video], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => { ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c)))); ff.stdin.on("error", () => {}); });
  const step = Number(process.env.FRAME_STEP ?? 1);
  for (let i = 0; i < FRAMES; i += step) {
    await pg.evaluate((t) => window.render(t), i / FPS);
    const buf = await pg.screenshot({ type: "jpeg", quality: 95 });
    for (let k = 0; k < step; k++) if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await done;
  await ctx.close();
  const mp4 = join(OUT_DIR, `promo-${lang}.mp4`);
  writeFileSync(mp4, readFileSync(video));
  // GIF preview: 480 px, 10 fps, shared palette; shrink until it fits under 5 MB.
  const gif = join(OUT_DIR, `promo-${lang}.gif`);
  for (const [w, fps, colors] of [[480, 10, 128], [480, 8, 96], [420, 8, 80], [384, 8, 64]]) {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-an", "-vf",
      `fps=${fps},scale=${w}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif], { stdio: "inherit" });
    if (statSync(gif).size <= 5 * 1024 * 1024 * 0.95) break;
  }
  console.log(lang, "mp4", statSync(mp4).size, "gif", statSync(gif).size);
}
await Promise.all(LANGS.map(build));
await browser.close();
console.log("words:", words.join(" "));
