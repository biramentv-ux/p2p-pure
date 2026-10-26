/**
 * Rebuilds docs/assets/tutorial-far-away.gif: nine illustrated steps in the "Sealed Post" theme.
 * Step 5 shows the real safety code (12 words, 3 lines of 4) computed with src/p2p/safety.ts.
 *   node scripts/docs/tutorial-gif.mjs            (needs playwright-core, vite, ffmpeg)
 * Env: CHROME_PATH, OUT_GIF, WORK_DIR.
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const OUT_GIF = process.env.OUT_GIF ?? join(root, "docs/assets/tutorial-far-away.gif");
const WORK = process.env.WORK_DIR ?? join(root, "tutorial-gif-work");
mkdirSync(WORK, { recursive: true });

// Real words from the real function (two fixed demo keys).
const vite = await createServer({ root, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const safety = await vite.ssrLoadModule("/src/p2p/safety.ts");
const a = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const b = Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 3) & 255);
const words = safety.safetyWords(a, b);
const lines = safety.formatSafetyCode(words).split("\n").map((l) => l.split(" · "));
await vite.close();
if (words.length !== 12 || lines.length !== 3) throw new Error("expected 12 words in 3 lines");

const font = (dir, name, w, sub) =>
  `@font-face{font-family:'${name}';font-weight:${w};src:url('${pathToFileURL(join(root, `node_modules/@fontsource/${dir}/files/${dir}-${sub}-${w}-normal.woff2`))}')}`;
const fonts = [
  ...["400", "500", "600"].flatMap((w) => [font("ibm-plex-serif", "Serif", w, "cyrillic"), font("ibm-plex-serif", "Serif", w, "latin"), font("ibm-plex-sans", "Sans", w, "cyrillic"), font("ibm-plex-sans", "Sans", w, "latin")]),
  ...["400", "500"].flatMap((w) => [font("ibm-plex-mono", "Mono", w, "cyrillic"), font("ibm-plex-mono", "Mono", w, "latin")]),
].join("\n");

const css = `${fonts}
*{box-sizing:border-box;margin:0}
body{width:640px;height:560px;background:#f1f5fa;color:#13213a;font-family:Sans,sans-serif;position:relative;overflow:hidden}
.top{height:36px;border-bottom:1px solid #cbd7e6;display:flex;justify-content:space-between;align-items:center;padding:0 9px}
.top b{font:500 15px Serif;color:#0c1628}.top i{font:500 8px Mono;letter-spacing:.18em;color:#5c6880;font-style:normal}
.stage{position:absolute;top:36px;left:0;width:640px;height:340px}
.who{position:absolute;top:16px;display:flex;gap:6px;align-items:center;font:600 11px Sans}
.av{width:16px;height:16px;border-radius:50%;color:#fff;font:600 8px/16px Sans;text-align:center}
.ph{position:absolute;top:42px;width:168px;height:290px;background:#fff;border:1px solid #cbd7e6;border-radius:16px;box-shadow:0 12px 28px -20px rgba(19,33,58,.4);padding:10px 12px;font-size:8px}
.ph h4{font:400 11px Serif;color:#0c1628;padding-bottom:7px;border-bottom:1px solid #cbd7e6;margin-bottom:8px}
.lab{font:500 6px Mono;letter-spacing:.16em;color:#5c6880;margin:6px 0 3px}
.btn{display:block;border-radius:6px;padding:7px 4px;text-align:center;font:600 8px Sans;background:#1f6fc4;color:#fff;margin:5px 0}
.btn.o{background:#fff;color:#13213a;border:1px solid #cbd7e6}.btn.m{background:#d41b7f}
.note{color:#5c6880;font-size:7px;line-height:1.5;margin-top:5px}
.arrow{position:absolute;top:170px;left:232px;width:176px;text-align:center;font:500 6.5px Mono;letter-spacing:.14em;color:#1f6fc4}
.arrow:after{content:"";display:block;height:1px;background:#1f6fc4;margin-top:6px;box-shadow:0 0 0}
.arrow:before{content:"";position:absolute;right:0;bottom:-3px;width:6px;height:6px;border-top:1px solid #1f6fc4;border-right:1px solid #1f6fc4;transform:rotate(45deg)}
.code{font:500 17px Mono;color:#1f6fc4;letter-spacing:.08em;margin:6px 0}
.qr{width:96px;height:96px;margin:2px auto;background:#fff;border:1px solid #cbd7e6;padding:6px}
.qr svg{width:100%;height:100%}
.words{border-top:2px solid #0c1628;border-bottom:1px solid #cbd7e6;margin:2px 0 8px;padding:3px 0}
.words div{font:500 7.2px/1.55 Mono;display:flex;justify-content:space-between;white-space:nowrap;padding:1.5px 0}
.words span{color:#13213a}.words em{color:#5c6880;font-style:normal}
.seal{width:20px;height:20px;border:2px solid #d41b7f;border-radius:50%;margin:0 auto 8px;display:flex;align-items:center;justify-content:center}
.seal:after{content:"";width:8px;height:8px;border:1.5px solid #d41b7f;border-radius:50%}
.bub{max-width:112px;border-radius:9px;padding:6px 8px;font-size:7.5px;line-height:1.35;margin:6px 0;border:1px solid #cbd7e6;background:#fff}
.bub.me{background:#1f6fc4;color:#fff;border-color:#1f6fc4;margin-left:auto}
.vid{height:84px;border-radius:8px;background:linear-gradient(160deg,#0f1b30,#243a60);position:relative}
.vid:after{content:"";position:absolute;right:6px;bottom:6px;width:24px;height:32px;border-radius:5px;background:#3d5b8a;border:1px solid #fff4}
.row{display:flex;gap:5px}.row .btn{flex:1}
.gav{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#6aa6e0,#d41b7f);margin:4px auto}
.dots{display:flex;gap:4px;justify-content:center;margin:6px 0}.dots i{width:5px;height:5px;border-radius:3px;background:#cbd7e6}
.dev{position:absolute;border:1px solid #cbd7e6;background:#fff;border-radius:12px;text-align:center;font:600 9px Sans;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
.dev small{font:500 6px Mono;letter-spacing:.14em;color:#5c6880}
.term{background:#0c1628;color:#e6eef8;font:500 6.5px/1.5 Mono;border-radius:4px;padding:6px 8px;text-align:left;width:calc(100% - 20px)}
.cap{position:absolute;left:12px;right:12px;top:392px;height:104px;background:#fff;border:1px solid #cbd7e6;border-left:3px solid #1f6fc4;border-radius:5px;padding:14px 16px}
.cap h3{font:400 17px Serif;color:#0c1628;margin-bottom:6px}.cap h3 u{text-decoration:none;font:600 6.5px Mono;letter-spacing:.18em;color:#d41b7f;margin-left:7px;vertical-align:2px}
.cap p{font-size:11px;line-height:1.5;color:#5c6880}
.prog{position:absolute;left:0;right:0;top:512px;display:flex;gap:5px;justify-content:center}.prog i{width:5px;height:5px;border-radius:3px;background:#cbd7e6}.prog i.on{width:20px;background:#1f6fc4}`;

const qrCells = (seed) => {
  let s = seed, out = "";
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
    const finder = (x < 6 && y < 6) || (x > 10 && y < 6) || (x < 6 && y > 10);
    if (!finder && r() > 0.5) out += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  for (const [fx, fy] of [[0, 0], [11, 0], [0, 11]]) out += `<rect x="${fx}" y="${fy}" width="6" height="6" fill="#0c1628"/><rect x="${fx + 1}" y="${fy + 1}" width="4" height="4" fill="#fff"/><rect x="${fx + 2}" y="${fy + 2}" width="2" height="2" fill="#0c1628"/>`;
  return `<svg viewBox="0 0 17 17" fill="#0c1628">${out}</svg>`;
};
const wordsHtml = `<div class="words">${lines.map((l) => `<div>${l.map((w) => `<span>${w}</span>`).join("<em>·</em>")}</div>`).join("")}</div>`;
const bubbles = (me) => `<div style="height:70px"></div>
  <div class="bub${me ? "" : " me"}">Здрасти, Петре!</div>
  <div class="bub${me ? " me" : ""}">Здрасти, Ани! Ето снимка</div>
  <div class="bub${me ? "" : " me"}">Пращам ти локация</div>`;
const both = (L, R) => [L, R];
const steps = [
  { t: "Всеки създава профил на своя телефон", p: "Без телефонен номер, без имейл и без регистрация. Ключовете остават само на устройството.",
    s: both(`<h4>Профил</h4><div style="height:78px"></div><div class="lab">НОВ ПРОФИЛ</div><div class="btn">Създай с passkey</div><div class="btn o">или с парола</div><div class="note">После запиши 12-те думи за възстановяване.</div>`, `<h4>Профил</h4><div style="height:78px"></div><div class="lab">НОВ ПРОФИЛ</div><div class="btn">Създай с passkey</div><div class="btn o">или с парола</div><div class="note">После запиши 12-те думи за възстановяване.</div>`) },
  { t: "Избират как да се свържат", n: 1, p: "Локален режим с QR код, или демо стая с кратък код, когато са далеч един от друг.",
    s: both(`<h4>Нов контакт</h4><div style="height:78px"></div><div class="btn">Локален (QR)</div><div class="btn o">Демо (стая)</div><div class="note">QR: лице в лице, без сървър. Стая: от разстояние, с кратък код.</div>`, `<h4>Нов контакт</h4><div style="height:78px"></div><div class="btn">Локален (QR)</div><div class="btn o">Демо (стая)</div><div class="note">Двамата избират един и същ начин.</div>`) },
  { t: "Ани показва покана, Петър я сканира", p: "Поканата е подписана от Ани. Кодът важи 10 минути и работи само веднъж.", a: "ПОКАНА",
    s: both(`<h4>Покана</h4><div class="qr">${qrCells(7)}</div><div class="lab" style="text-align:center">ИЛИ КРАТЪК КОД</div><div class="code" style="text-align:center;font-size:12px">ABCDE-FGHJK</div>`, `<h4>Сканирай покана</h4><div class="qr" style="background:#0c1628;border-color:#0c1628;padding:8px"><div style="background:#fff;height:100%;padding:5px">${qrCells(7)}</div></div><div class="note">Или въведи краткия код.</div>`) },
  { t: "От разстояние: демо стая с код", n: 1, p: "Сървърът само препраща подписаната покана. Съобщенията после вървят директно между телефоните.", a: "СТАЯ",
    s: both(`<h4>Демо стая</h4><div style="height:68px"></div><div class="lab">КОД НА СТАЯТА</div><div class="code">K7M2Q-9XR4T</div><div class="note">Изпрати кода на Петър по какъвто канал искаш.</div><div class="btn o" style="margin-top:12px">Чакам Петър...</div>`, `<h4>Демо стая</h4><div style="height:78px"></div><div class="lab">КРАТЪК КОД</div><div class="btn o" style="text-align:left;font:500 8px Mono;padding:7px 6px">K7M2Q-9XR4T</div><div class="btn">Присъедини се</div>`) },
  { t: "Сравняват дванайсетте думи на глас", p: "Ако думите са еднакви, никой не стои между тях. Контактът получава печат „потвърден“.",
    s: both(`<h4>Проверка</h4>${wordsHtml}<div class="seal"></div><div class="btn m">Думите съвпадат</div>`, `<h4>Проверка</h4>${wordsHtml}<div class="seal"></div><div class="btn m">Думите съвпадат</div>`) },
  { t: "Пишат си, пращат снимки и локация", p: "Всичко е шифровано от край до край и се пази шифровано на телефона.", a: "ШИФРОВАНО",
    s: both(`<h4>Петър</h4>${bubbles(false)}`, `<h4>Ани</h4>${bubbles(true)}`) },
  { t: "Звънят си с аудио или видео", n: 1, p: "Разговорът минава по същата директна връзка, без сървър по средата.", a: "АУДИО · ВИДЕО",
    s: both(`<h4>Разговор</h4><div class="vid"></div><div class="lab">В РАЗГОВОР · 02:14</div><div class="row"><div class="btn o">Заглуши</div><div class="btn m">Край</div></div>`, `<h4>Разговор</h4><div class="vid"></div><div class="lab">В РАЗГОВОР · 02:14</div><div class="row"><div class="btn o">Заглуши</div><div class="btn m">Край</div></div>`) },
  { t: "Групов чат до 9 души", n: 1, p: "Админът кани членове, слага снимка на групата и сменя ключа, когато някой излезе.",
    s: both(`<h4>Група</h4><div class="gav"></div><div style="text-align:center;font:400 10px Serif">Семейство</div><div class="note" style="text-align:center">Ани е админ. До 9 души.</div><div class="btn" style="margin-top:14px">Покани член</div>`, `<h4>Група</h4><div style="height:30px"></div><div class="bub">Ани: Вечеря в 19:00?</div><div class="bub me">Идвам!</div><div class="note">Историята се пази шифрована.</div>`) },
  { t: "Работи на телефон, компютър и Windows", n: 1, p: "Отвори в браузъра и „Добави към началния екран“, или инсталирай програмата за Windows.", dev: true },
];
const names = [["Ани", "#1f6fc4", "А"], ["Петър", "#d41b7f", "П"]];
const page = (i) => {
  const st = steps[i];
  const stage = st.dev
    ? `<div class="dev" style="left:40px;top:80px;width:96px;height:140px">Телефон<small>PWA · БРАУЗЪР</small></div>
       <div class="dev" style="left:164px;top:44px;width:236px;height:150px;top:50px">Windows<small>ИНСТАЛАТОР · PORTABLE</small><div class="term">winget install<br>DyrakArmy.P2PMessenger</div></div>
       <div class="dev" style="left:424px;top:70px;width:130px;height:110px;top:100px;left:432px;width:116px;height:96px">Chrome<small>РАЗШИРЕНИЕ</small></div>`
    : `${names.map(([n, c, l], k) => `<div class="who" style="left:${k ? 400 : 62}px;width:168px;justify-content:center"><span class="av" style="background:${c}">${l}</span>${n}</div>`).join("")}
       <div class="ph" style="left:62px">${st.s[0]}</div><div class="ph" style="left:410px">${st.s[1]}</div>${st.a ? `<div class="arrow">${st.a}</div>` : ""}`;
  return `<!doctype html><meta charset=utf-8><style>${css}</style>
  <div class="top"><b>Как се свързват Ани и Петър</b><i>СТЪПКА ${i + 1} / 9</i></div>
  <div class="stage">${stage}</div>
  <div class="cap"><h3>${st.t}${st.n ? "<u>НОВО</u>" : ""}</h3><p>${st.p}</p></div>
  <div class="prog">${steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>`;
};

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 560 }, deviceScaleFactor: 2, locale: "bg-BG" });
const pg = await ctx.newPage();
for (let i = 0; i < steps.length; i++) {
  const f = join(WORK, `s${i + 1}.html`);
  writeFileSync(f, page(i));
  await pg.goto(pathToFileURL(f).href);
  await pg.evaluate(() => document.fonts.ready);
  await pg.screenshot({ path: join(WORK, `s${i + 1}.png`) });
}
await browser.close();

// Stills -> crossfaded GIF at 10 fps, one shared palette.
const HOLD = 3.4, FADE = 0.6;
const inputs = steps.flatMap((_, i) => ["-loop", "1", "-t", String(HOLD + FADE), "-i", join(WORK, `s${i + 1}.png`)]);
let chain = "", prev = "[0:v]";
steps.forEach((_, i) => { chain += `[${i}:v]scale=640:560:flags=lanczos,format=yuv420p,fps=10[v${i}];`; });
prev = "[v0]";
for (let i = 1; i < steps.length; i++) {
  chain += `${prev}[v${i}]xfade=transition=fade:duration=${FADE}:offset=${(HOLD * i).toFixed(2)}[x${i}];`;
  prev = `[x${i}]`;
}
chain += `${prev}split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", chain, "-loop", "0", OUT_GIF], { stdio: "inherit" });
console.log("wrote", OUT_GIF, readFileSync(OUT_GIF).length, "bytes; words:", words.join(" "));
