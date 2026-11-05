/**
 * Rebuilds docs/assets/tutorial-connect-{bg,en}.gif: "7 ways to connect" tutorial (intro card, a 3-step
 * mini-sequence for each of the 7 methods from docs/CONNECTING.md, the common "compare the 12 words" step and
 * a "Connected" end card). Stills in the "Sealed Post" theme (IBM Plex from node_modules), 720 px wide,
 * crossfaded at 6 fps with one shared palette. The 12 safety words are the real ones from src/p2p/safety.ts.
 *
 *   node scripts/docs/tutorial-connect-gif.mjs            (needs playwright-core, vite, ffmpeg)
 *
 * Env: CHROME_PATH, OUT_DIR (default docs/assets), LANGS=bg,en, WORK_DIR (keeps the per-frame PNGs there),
 *      HOLD (seconds per frame, default 2.8), COLORS (palette size, default 128).
 * The older scripts/docs/tutorial-gif.mjs (nine-step "far away" tutorial) is independent and still works.
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const CHROME_PATH = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const OUT_DIR = process.env.OUT_DIR ?? join(root, "docs/assets");
const WORK = process.env.WORK_DIR ?? join(root, "tutorial-connect-work");
const LANGS = (process.env.LANGS ?? "bg,en").split(",").map((s) => s.trim()).filter(Boolean);
const HOLD = Number(process.env.HOLD ?? 2.8), FADE = 0.25, FPS = 6, COLORS = Number(process.env.COLORS ?? 128);
const W = 720, H = 616;
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// Real safety words from the real function (the same two demo keys as the other docs animations).
const vite = await createServer({ root, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
const safety = await vite.ssrLoadModule("/src/p2p/safety.ts");
const ka = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const kb = Uint8Array.from({ length: 32 }, (_, i) => (255 - i * 3) & 255);
const words = safety.safetyWords(ka, kb);
const lines = safety.formatSafetyCode(words).split("\n").map((l) => l.split(" · "));
await vite.close();
if (words.length !== 12 || lines.length !== 3) throw new Error("expected 12 words in 3 lines");

const face = (dir, name, w, sub, range) =>
  `@font-face{font-family:'${name}';font-weight:${w};font-display:block;src:url('${pathToFileURL(join(root, `node_modules/@fontsource/${dir}/files/${dir}-${sub}-${w}-normal.woff2`))}') format('woff2');unicode-range:${range}}`;
const CYR = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";
const LAT = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const fam = (dir, name, ws) => ws.flatMap((w) => [face(dir, name, w, "cyrillic", CYR), face(dir, name, w, "latin", LAT)]);
const fonts = [...fam("ibm-plex-serif", "Serif", ["400", "500"]), ...fam("ibm-plex-sans", "Sans", ["400", "500", "600"]), ...fam("ibm-plex-mono", "Mono", ["500"])].join("\n");

const css = `${fonts}
*{box-sizing:border-box;margin:0}
body{width:${W}px;height:${H}px;background:#f1f5fa;color:#13213a;font-family:Sans,sans-serif;position:relative;overflow:hidden}
.top{height:44px;border-bottom:1px solid #cbd7e6;display:flex;justify-content:space-between;align-items:center;padding:0 16px}
.top b{font:500 17px Serif;color:#0c1628}
.dots{display:flex;gap:6px}.dots i{width:22px;height:22px;border-radius:50%;border:1px solid #cbd7e6;background:#fff;font:500 11px/20px Mono;text-align:center;color:#5c6880;font-style:normal}
.dots i.on{background:#1f6fc4;border-color:#1f6fc4;color:#fff}.dots i.done{border-color:#1f6fc4;color:#1f6fc4}
.pill{position:absolute;top:56px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:center}
.pill span{background:#0c1628;color:#fff;border-radius:14px;padding:5px 12px;font:600 13px Sans}
.pill em{font:500 11px Mono;letter-spacing:.14em;color:#5c6880;font-style:normal}
.who{position:absolute;top:92px;display:flex;gap:6px;align-items:center;justify-content:center;font:600 14px Sans}
.av{width:20px;height:20px;border-radius:50%;color:#fff;font:600 11px/20px Sans;text-align:center}
.ph{position:absolute;top:118px;height:296px;background:#fff;border:1.5px solid #b6c5da;border-radius:20px;box-shadow:0 14px 28px -20px rgba(19,33,58,.45);padding:12px 12px;font-size:12px;overflow:hidden}
.ph.lap{border-radius:10px 10px 4px 4px;top:150px;height:214px}
.base{position:absolute;top:364px;height:12px;background:#b6c5da;border-radius:0 0 14px 14px}
.ph h4{font:400 14px Serif;color:#0c1628;padding-bottom:6px;border-bottom:1px solid #cbd7e6;margin-bottom:8px}
.lab{font:500 9.5px Mono;letter-spacing:.12em;color:#5c6880;margin:7px 0 3px;text-transform:uppercase}
.btn{display:block;border-radius:7px;padding:8px 4px;text-align:center;font:600 12px Sans;background:#1f6fc4;color:#fff;margin:6px 0}
.btn.o{background:#fff;color:#13213a;border:1px solid #b6c5da}.btn.m{background:#d41b7f}.btn.g{background:#e6eef8;color:#5c6880}
.btn.sel{outline:3px solid #f2b705;outline-offset:1px}
.note{color:#5c6880;font-size:11px;line-height:1.4;margin-top:5px}
.code{font:500 20px Mono;color:#1f6fc4;letter-spacing:.04em;text-align:center;margin:6px 0}
.code small{display:block;font:500 15px Mono;color:#0c1628;letter-spacing:0;margin-top:3px}
.qr{width:128px;height:128px;margin:6px auto;background:#fff;border:1px solid #cbd7e6;padding:6px}.qr svg{width:100%;height:100%}
.qr.cam{background:#0c1628;border-color:#0c1628;padding:9px}.qr.cam div{background:#fff;height:100%;padding:5px}
.words{border-top:2px solid #0c1628;border-bottom:1px solid #cbd7e6;margin:4px 0 8px;padding:4px 0}
.words div{font:500 11.5px/1.5 Mono;display:flex;justify-content:space-between;white-space:nowrap;padding:2px 0}.words em{color:#5c6880;font-style:normal}
.seal{width:26px;height:26px;border:2px solid #d41b7f;border-radius:50%;margin:0 auto 8px;display:flex;align-items:center;justify-content:center}
.seal:after{content:"";width:10px;height:10px;border:1.5px solid #d41b7f;border-radius:50%}
.bar{height:8px;border-radius:4px;background:#e6eef8;margin:6px 0;overflow:hidden}.bar i{display:block;height:100%;background:#1f6fc4}
.row{display:flex;gap:6px}.row .btn{flex:1}
.item{border:1px solid #cbd7e6;border-radius:8px;padding:7px 9px;margin:5px 0;font:500 12px Sans;display:flex;justify-content:space-between;align-items:center}
.item.sel{border:2px solid #1f6fc4;background:#eaf2fc}.item b{font:500 13px Mono;color:#1f6fc4}
.chk{width:16px;height:16px;border-radius:4px;border:1.5px solid #b6c5da;display:inline-block;vertical-align:middle;margin-right:7px}.chk.on{background:#1f6fc4;border-color:#1f6fc4;box-shadow:inset 0 0 0 2px #fff}
.wave{display:flex;gap:3px;align-items:center;justify-content:center;height:70px}.wave i{width:5px;border-radius:3px;background:#1f6fc4}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:3px;width:132px;height:132px;margin:6px auto}.grid i{border-radius:3px}
.warn{border:1.5px solid #f2b705;background:#fff8dc;border-radius:8px;padding:8px;font-size:11.5px;line-height:1.4;margin:4px 0 6px}
.view{height:92px;border-radius:8px;background:linear-gradient(160deg,#0f1b30,#243a60);position:relative;margin:6px 0}
.view:after{content:"";position:absolute;inset:14px 26px;border:2px solid #fff9;border-radius:6px}
.bub{max-width:150px;border-radius:10px;padding:7px 9px;font-size:11.5px;line-height:1.35;margin:6px 0;border:1px solid #cbd7e6;background:#fff;}
.bub.me{background:#d9ecff;border-color:#9cc4ee;margin-left:auto}
.bub.tg{font:500 10.5px Mono;background:#e9f4ff}
.srv{position:absolute;border:1.5px dashed #5c6880;border-radius:10px;background:#fff;text-align:center;font:600 12px Sans;padding:8px 6px;line-height:1.35}
.srv small{display:block;font:500 10px Mono;color:#5c6880;letter-spacing:.06em;margin-top:3px}
.arr{position:absolute;text-align:center;font:600 11px/1.3 Mono;letter-spacing:.08em;color:#1f6fc4;text-transform:uppercase}
.arr svg{display:block;width:100%;height:14px;margin-top:5px;overflow:visible}
.link{position:absolute;height:0;border-top:2px solid #1f6fc4}
.linklab{position:absolute;text-align:center;font:500 9px/1.2 Mono;color:#1f6fc4;letter-spacing:.06em;text-transform:uppercase}
.cap{position:absolute;left:14px;right:14px;top:428px;height:172px;background:#fff;border:1px solid #cbd7e6;border-left:4px solid #1f6fc4;border-radius:6px;padding:14px 20px}
.cap h3{font:500 27px/1.2 Serif;color:#0c1628;margin-bottom:12px}
.cap p{font-size:20px;line-height:1.45;color:#3d4a62}
.cap p b{color:#0c1628}
.intro{position:absolute;top:60px;left:30px;right:30px}
.intro h1{font:500 38px/1.15 Serif;color:#0c1628;margin:8px 0 6px}.intro .sub{font-size:16px;color:#5c6880;margin-bottom:16px;line-height:1.4}
.meth{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px}.foot{margin-top:18px;border-left:4px solid #d41b7f;padding:4px 0 4px 14px;font-size:17px;line-height:1.4;color:#3d4a62}
.meth div{background:#fff;border:1px solid #cbd7e6;border-radius:9px;padding:13px 14px;font:600 16px Sans;display:flex;gap:10px;align-items:center}
.meth div:last-child{grid-column:1 / 3}
.meth b{width:28px;height:28px;border-radius:50%;background:#1f6fc4;color:#fff;font:500 14px/28px Mono;text-align:center;flex:none}
.meth small{display:block;font:400 12px Sans;color:#5c6880;margin-top:1px}
.end{position:absolute;top:110px;left:0;right:0;text-align:center}
.end .big{width:96px;height:96px;margin:0 auto 18px;border:5px solid #d41b7f;border-radius:50%;display:flex;align-items:center;justify-content:center}
.end .big:after{content:"";width:40px;height:40px;border:3px solid #d41b7f;border-radius:50%}
.end h1{font:500 48px Serif;color:#0c1628;margin-bottom:10px}.end p{font-size:18px;color:#3d4a62;line-height:1.5;padding:0 60px}`;

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
const qr = (seed) => `<div class="qr">${qrCells(seed)}</div>`;
const camQr = (seed) => `<div class="qr cam"><div>${qrCells(seed)}</div></div>`;
// Calm, red-free colour squares (the real animation avoids red and keeps brightness nearly constant).
const grid = (seed) => {
  const pal = ["#2f8f6b", "#2a6fb8", "#8a5ab5", "#c9a227", "#2a9db0", "#5b7fd6"];
  let s = seed;
  return `<div class="grid">${Array.from({ length: 36 }, () => `<i style="background:${pal[(s = (s * 1103515245 + 12345) & 0x7fffffff) % 6]}"></i>`).join("")}</div>`;
};
const wave = () => `<div class="wave">${[14, 30, 46, 24, 56, 38, 18, 50, 34, 60, 26, 42, 16, 36, 22].map((h) => `<i style="height:${h}px"></i>`).join("")}</div>`;
const bar = (p) => `<div class="bar"><i style="width:${p}%"></i></div>`;
const wordsHtml = `<div class="words">${lines.map((l) => `<div>${l.map((w) => `<span>${w}</span>`).join("<em>·</em>")}</div>`).join("")}</div>`;

// ---------------------------------------------------------------- texts: [bg, en]
const D = {
  brand: ["P2P Pure", "P2P Pure"],
  title7: ["7 начина да се свържете", "7 ways to connect"],
  sub7: ["Първата връзка иска размяна на по една подписана покана. Изберете според това дали сте заедно и дали ползвате сървър.", "The first link needs one signed invitation each way. Pick by whether you are together and whether a server is in the path."],
  stepWord: ["СТЪПКА", "STEP"],
  newContact: ["Нов контакт", "New contact"],
  local: ["Локален (QR)", "Local (QR)"], demo: ["Демо (стая)", "Demo (room)"], ble: ["Bluetooth", "Bluetooth"],
  qrSound: ["QR + звук", "QR + sound"], qrLight: ["QR + светлина", "QR + light"],
  showInv: ["Покажи моята покана", "Show my invitation"], scanInv: ["Сканирай чужда покана", "Scan someone else's invitation"],
  scanAns: ["Сканирай отговора", "Scan the answer"], join: ["Присъедини се", "Join"],
  enterRoom: ["Въведи кода на стаята", "Enter the room code"], cameraOn: ["Включи камерата", "Turn camera on"],
  showQrInstead: ["Покажи QR вместо това", "Show the QR instead"], startAnim: ["Разбрах, пусни анимацията", "Understood, start the animation"],
  warn: ["Анимацията сменя цветни квадратчета 3 пъти в секунда. Ако сте чувствителни към мигаща светлина, използвайте QR кода.", "The animation changes coloured squares 3 times a second. If you are sensitive to flashing light, use the QR code."],
  btConnect: ["Свързване по Bluetooth", "Connect over Bluetooth"], btLooking: ["Търся телефони наблизо…", "Looking for phones nearby…"],
  listening: ["Слушам…", "Listening…"], received: ["Получено", "Received"], searching: ["Търся", "Searching"], found: ["Намерено", "Found"],
  matched: ["Кодът съвпадна. Свързвам…", "The code matched. Connecting…"],
  words12: ["Думите съвпадат", "The words match"], check: ["Проверка", "Verify"],
  contacts: ["Контакти", "Contacts"], introTwo: ["Запознай двама", "Introduce two people"],
  accept: ["Приеми", "Accept"], decline: ["Откажи", "Decline"], introduce: ["Запознанства", "Introductions"],
  copyCode: ["Копирай кода", "Copy code"], pasteCode: ["Няма камера? Постави кода ръчно", "No camera? Paste the code manually"],
  connected: ["Свързани", "Connected"],
  profile: ["Профил", "Profile"], room: ["Стая", "Room"], waiting: ["Чакам другия човек…", "Waiting for the other person…"],
};

const people = { A: ["Ани", "#1f6fc4", "А"], B: ["Петър", "#d41b7f", "П"], C: ["Ива", "#2a9d6b", "И"] };
const ROOM = "K7M2Q", THREE = "lemon-rocket-bridge", TAG = "7QK2";

function build(lang) {
  const i = lang === "bg" ? 0 : 1;
  const T = (k) => D[k][i];
  const L = (bg, en) => (i === 0 ? bg : en);
  const nm = (k) => (i === 0 ? people[k][0] : { A: "Ani", B: "Petar", C: "Iva" }[k]);
  const methods = [
    { n: 1, name: L("QR лице в лице", "QR, face to face"), steps: [
      { t: L("И двамата избират „Локален (QR)“", "Both pick “Local (QR)”"),
        p: L(`Двамата са заедно. <b>Ани</b> натиска „Покажи моята покана“, <b>Петър</b> — „Сканирай чужда покана“.`, `You are together. <b>${nm("A")}</b> taps “Show my invitation”, <b>${nm("B")}</b> taps “Scan someone else's invitation”.`),
        dev: [{ w: "A", h: T("newContact"), html: `<div class="btn sel">${T("local")}</div><div class="btn o">${T("demo")}</div><div class="btn o">${T("ble")}</div><div class="btn g">${T("showInv")}</div>` },
              { w: "B", h: T("newContact"), html: `<div class="btn sel">${T("local")}</div><div class="btn o">${T("demo")}</div><div class="btn o">${T("ble")}</div><div class="btn g">${T("scanInv")}</div>` }] },
      { t: L("Ани показва QR, Петър го сканира", `${nm("A")} shows a QR, ${nm("B")} scans it`),
        p: L("Поканата е подписана текст в QR код. Няма мрежови заявки.", "The invitation is signed text in a QR code. No network requests."), arrow: L("сканира →", "scans →"),
        dev: [{ w: "A", h: L("Покана", "Invitation"), html: qr(7) + `<div class="note" style="text-align:center">${L("Нека другият сканира този код.", "Let the other person scan this code.")}</div>` },
              { w: "B", h: T("scanInv"), html: camQr(7) + `<div class="note" style="text-align:center">${L("Сканирай QR кода, който показва другият човек.", "Scan the QR code the other person shows.")}</div>` }] },
      { t: L("Петър показва отговор, Ани го сканира", `${nm("B")} shows the reply, ${nm("A")} scans it`),
        p: L("Ролите се сменят: втори QR код. <b>Двата кода се виждат от всеки до вас.</b>", "Roles swap: a second QR code. <b>Anyone next to you can see both codes.</b>"), arrow: L("← сканира", "← scans"),
        dev: [{ w: "A", h: T("scanAns"), html: camQr(12) + `<div class="note" style="text-align:center">${L("Сканирай QR кода на другото устройство.", "Scan the QR code on the other device.")}</div>` },
              { w: "B", h: L("Отговор", "Reply"), html: qr(12) + `<div class="note" style="text-align:center">${L("Покажи го на Ани.", "Show it to Ani.")}</div>` }] },
    ] },
    { n: 2, name: L("Кратък код", "Short code"), steps: [
      { t: L("Ани избира „Демо (стая)“", `${nm("A")} picks “Demo (room)”`),
        p: L(`Приложението отваря стая и показва код: <b>5 знака + 3 думи</b>. Трите думи остават на устройствата.`, `The app opens a room and shows a code: <b>5 characters + 3 words</b>. The three words stay on the devices.`),
        dev: [{ w: "A", h: T("room"), html: `<div class="btn o">${T("local")}</div><div class="btn sel">${T("demo")}</div><div class="lab">${L("Код на стаята", "Room code")}</div><div class="code">${ROOM}<small>${THREE}</small></div><div class="note">${T("waiting")}</div>` },
              { w: "B", h: T("newContact"), lap: true, html: `<div class="row"><div class="btn o">${T("local")}</div><div class="btn sel">${T("demo")}</div></div><div class="lab">${T("enterRoom")}</div><div class="item" style="color:#8a96ab">_ _ _ _ _  _ _ _</div><div class="btn g">${T("join")}</div>` }] },
      { t: L("Ани казва кода на глас или по телефона", `${nm("A")} says the code aloud or by phone`),
        p: L("Петър го въвежда и натиска „Присъедини се“. Достатъчни са първите 4 букви от всяка дума.", `${nm("B")} types it and taps “Join”. The first 4 letters of each word are enough.`), arrow: L("на глас", "aloud"),
        dev: [{ w: "A", h: T("room"), html: `<div class="lab">${L("Код на стаята", "Room code")}</div><div class="code">${ROOM}<small>${THREE}</small></div><div class="note">${T("waiting")}</div>` },
              { w: "B", h: T("newContact"), lap: true, html: `<div class="row"><div class="btn o">${T("local")}</div><div class="btn sel">${T("demo")}</div></div><div class="lab">${T("enterRoom")}</div><div class="item" style="font:500 11.5px Mono;padding:7px 5px">${ROOM} ${THREE}</div><div class="btn">${T("join")}</div>` }] },
      { t: L("Сървърът вижда само номера на стаята", "The server sees only the room number"),
        p: L(`Двете устройства проверяват трите думи (CPace) и чак тогава пращат поканата, шифрована. <b>Грешна дума проваля сдвояването.</b>`, `Both devices check the three words (CPace) and only then send the invitation, encrypted. <b>A wrong word fails the pairing.</b>`), srv: { l: L("Сървър", "Server"), s: ROOM + " · " + L("шифр. текст", "ciphertext") },
        dev: [{ w: "A", h: T("room"), html: `<div class="lab">${L("Код на стаята", "Room code")}</div><div class="code">${ROOM}</div>${bar(100)}<div class="note" style="color:#1f6fc4">${T("matched")}</div>` },
              { w: "B", h: T("room"), lap: true, html: `<div class="lab">${L("Код на стаята", "Room code")}</div><div class="code">${ROOM}</div>${bar(100)}<div class="note" style="color:#1f6fc4">${T("matched")}</div>` }] },
    ] },
    { n: 3, name: "Bluetooth", steps: [
      { t: L("Само в приложението: Ани избира Bluetooth", `App only: ${nm("A")} picks Bluetooth`),
        p: L(`Работи само в приложението за Android и iOS. Телефонът на Ани показва <b>код от 4 знака</b>.`, `Works only in the Android and iOS app. ${nm("A")}'s phone shows a <b>4-character code</b>.`),
        dev: [{ w: "A", h: T("btConnect"), html: `<div class="btn o">${T("local")}</div><div class="btn sel">${T("ble")}</div><div class="lab">${L("Мой код", "My code")}</div><div class="code">${TAG}</div><div class="note">${T("waiting")}</div>` },
              { w: "B", h: T("newContact"), html: `<div class="btn o">${T("local")}</div><div class="btn sel">${T("ble")}</div><div class="btn g">${L("Търси телефони", "Look for phones")}</div><div class="note">${L("Приложение за Android / iOS", "Android / iOS app")}</div>` }] },
      { t: L("Петър я избира от списъка", `${nm("B")} picks it from the list`),
        p: L(`Кодът само избира телефон, <b>не е защита</b>. Нужни са около 10 м разстояние или по-малко.`, `The code only picks a phone, <b>it is not protection</b>. Stay within about 10 m.`), arrow: "BLE ≈10 m",
        dev: [{ w: "A", h: T("btConnect"), html: `<div class="lab">${L("Мой код", "My code")}</div><div class="code">${TAG}</div><div class="note">${T("waiting")}</div>` },
              { w: "B", h: T("btConnect"), html: `<div class="lab">${T("btLooking")}</div><div class="item sel">${L("Телефон", "Phone")} <b>${TAG}</b></div><div class="item">${L("Телефон", "Phone")} <b>M3XN</b></div>` }] },
      { t: L("Поканата минава на части по Bluetooth", "The invitation travels in parts over Bluetooth"),
        p: L("Около 30 секунди, най-много 60. Сървър за поканата няма. После WebRTC връзката се прави по мрежата.", "About 30 seconds, 60 at most. No server for the invitation. The WebRTC link is then made over the network."), arrow: L("покана →", "invitation →"),
        dev: [{ w: "A", h: T("btConnect"), html: `<div class="lab">${T("received")}</div>${bar(100)}<div class="note" style="color:#1f6fc4">${T("matched").replace(/.*\. /, "")}</div>` },
              { w: "B", h: T("btConnect"), html: `<div class="lab">${L("Пращам…", "Sending…")}</div>${bar(64)}<div class="note">${L("Телефон", "Phone")} ${TAG}</div>` }] },
    ] },
    { n: 4, name: L("QR + звук", "QR + sound"), steps: [
      { t: L("Ани избира „QR + звук“ и показва QR", `${nm("A")} picks “QR + sound” and shows a QR`),
        p: L(`Двамата са в една стая. Нужни са микрофон и говорител.`, `You are in the same room. A microphone and a speaker are needed.`),
        dev: [{ w: "A", h: T("newContact"), html: `<div class="btn o">${T("local")}</div><div class="btn sel">${T("qrSound")}</div><div class="btn g">${T("showInv")}</div>` },
              { w: "B", h: T("newContact"), html: `<div class="btn o">${T("local")}</div><div class="btn sel">${T("qrSound")}</div><div class="btn g">${T("scanInv")}</div>` }] },
      { t: L("Петър сканира QR кода", `${nm("B")} scans the QR`),
        p: L("Телефонът на Петър подготвя кратък подписан отговор (около 200 байта).", `${nm("B")}'s phone prepares a short signed reply (about 200 bytes).`), arrow: L("сканира →", "scans →"),
        dev: [{ w: "A", h: L("Покана", "Invitation"), html: qr(21) + `<div class="note" style="text-align:center">${L("Нека другият човек сканира този код.", "Let the other person scan this code.")}</div>` },
              { w: "B", h: T("scanInv"), html: camQr(21) }] },
      { t: L("Петър пуска отговора като звук", `${nm("B")} plays the reply as sound`),
        p: L("Ани слуша с микрофона около <b>15 секунди</b>. Не стигне ли звукът, има QR вместо звук.", `${nm("A")} listens with the microphone for about <b>15 seconds</b>. If the sound fails, a QR is shown instead.`), arrow: L("← звук ~15 с", "← sound ~15 s"),
        dev: [{ w: "A", h: T("qrSound"), html: `<div class="lab">${T("listening")}</div>${wave().replace("#1f6fc4", "#1f6fc4")}<div class="lab">${T("received")}</div>${bar(70)}` },
              { w: "B", h: T("qrSound"), html: `<div class="lab">${L("Пускам отговора…", "Playing the reply…")}</div>${wave()}<div class="btn g">${T("showQrInstead")}</div>` }] },
    ] },
    { n: 5, name: L("QR + светлина", "QR + light"), steps: [
      { t: L("Ани показва QR и включва камерата", `${nm("A")} shows a QR and turns the camera on`),
        p: L("Петър сканира QR кода. Нужна е камера и на двете устройства.", `${nm("B")} scans the QR code. Both devices need a camera.`), arrow: L("сканира →", "scans →"),
        dev: [{ w: "A", h: T("qrLight"), html: qr(33) + `<div class="btn o">${T("cameraOn")}</div>` },
              { w: "B", h: T("scanInv"), html: camQr(33) }] },
      { t: L("Петър вижда предупреждение", `${nm("B")} sees a warning`),
        p: L("Заради фоточувствителност анимацията е бавна (до 3 смени в секунда) и <b>никога не тръгва сама</b>.", "For light-sensitive people the animation is slow (at most 3 changes a second) and <b>never starts by itself</b>."),
        dev: [{ w: "A", h: T("qrLight"), html: `<div class="view"></div><div class="lab">${T("searching")}</div>${bar(0)}` },
              { w: "B", h: L("Внимание", "Warning"), html: `<div class="warn">${T("warn")}</div><div class="btn">${T("startAnim")}</div><div class="btn o">${T("showQrInstead")}</div>` }] },
      { t: L("Анимацията носи отговора към камерата", "The animation carries the reply to the camera"),
        p: L("Цветни квадратчета, около <b>3–8 секунди</b>. Камерата на Ани я чете от всеки кадър.", `Coloured squares for about <b>3–8 seconds</b>. ${nm("A")}'s camera can start from any frame.`), arrow: L("← светлина", "← light"),
        dev: [{ w: "A", h: T("qrLight"), html: `<div class="view"></div><div class="lab">${T("found")}</div>${bar(80)}<div class="note">${T("received")}</div>` },
              { w: "B", h: T("qrLight"), html: grid(5) + `<div class="btn g">${L("Спри анимацията", "Stop the animation")}</div>` }] },
    ] },
    { n: 6, name: L("Общ приятел", "Mutual friend"), steps: [
      { t: L("Тримата са свързани едновременно", "All three are connected at once"),
        p: L(`Ива е контакт и на Ани, и на Петър. Покани минават по <b>вече шифрованите връзки</b>, без сървър.`, `${nm("C")} is a contact of both ${nm("A")} and ${nm("B")}. Invitations travel over <b>the existing encrypted links</b>, no server.`), three: 1,
        dev: [{ w: "A", h: T("contacts"), html: `<div class="item">${nm("C")} <b>✓</b></div><div class="item" style="color:#8a96ab">${nm("B")}?</div>` },
              { w: "C", h: T("contacts"), html: `<div class="item">${nm("A")} <b>✓</b></div><div class="item">${nm("B")} <b>✓</b></div>` },
              { w: "B", h: T("contacts"), html: `<div class="item">${nm("C")} <b>✓</b></div><div class="item" style="color:#8a96ab">${nm("A")}?</div>` }] },
      { t: L("Ива избира „Запознай двама“", `${nm("C")} taps “Introduce two people”`),
        p: L("Избира двата контакта — Ани и Петър. Приложението ѝ праща подписаните покани.", `${nm("C")} picks the two contacts, ${nm("A")} and ${nm("B")}. Her app forwards the signed invitations.`), three: 1,
        dev: [{ w: "A", h: T("contacts"), html: `<div class="item">${nm("C")} <b>✓</b></div>` },
              { w: "C", h: T("introTwo"), html: `<div class="item sel"><span><i class="chk on"></i>${nm("A")}</span></div><div class="item sel"><span><i class="chk on"></i>${nm("B")}</span></div><div class="btn">${T("introTwo")}</div>` },
              { w: "B", h: T("contacts"), html: `<div class="item">${nm("C")} <b>✓</b></div>` }] },
      { t: L("И двамата приемат", "Both accept"),
        p: L(`Ани и Петър приемат в „Запознанства“. Новият контакт е <b>непроверен</b>, докато не сравнят 12-те думи.`, `${nm("A")} and ${nm("B")} accept under “Introductions”. The new contact is <b>not verified</b> until they compare the 12 words.`), three: 1,
        dev: [{ w: "A", h: T("introduce"), html: `<div class="lab">${L("Покана от Ива", "From Iva")}</div><div class="item">${nm("B")}</div><div class="btn sel">${T("accept")}</div><div class="btn o">${T("decline")}</div>` },
              { w: "C", h: T("introduce"), html: `<div class="lab">${L("Чака", "Waiting")}</div><div class="item">${nm("A")} ✓</div><div class="item">${nm("B")} ✓</div>` },
              { w: "B", h: T("introduce"), html: `<div class="lab">${L("Покана от Ива", "From Iva")}</div><div class="item">${nm("A")}</div><div class="btn sel">${T("accept")}</div><div class="btn o">${T("decline")}</div>` }] },
    ] },
    { n: 7, name: L("Telegram бот / копирана покана", "Telegram bot / copied invitation"), steps: [
      { t: L("Петър копира поканата си", `${nm("B")} copies his invitation`),
        p: L(`В приложението натиска „Копирай кода“. Поканата започва с <b>p2p1:</b>.`, `In the app he taps “Copy code”. The invitation starts with <b>p2p1:</b>.`),
        dev: [{ w: "A", h: "Telegram", html: `<div class="bub">/start</div><div class="bub tg">${L("Твоят код", "Your code")}: MTIzNDU2</div>` },
              { w: "B", h: T("newContact"), html: `<div class="btn g">${T("showInv")}</div><div class="lab">${L("Покана", "Invitation")}</div><div class="item" style="font:500 10px Mono">p2p1:AAECAwQFBgcI…</div><div class="btn sel">${T("copyCode")}</div>` }] },
      { t: L("Праща я през Telegram бота", "Sends it through the Telegram bot"),
        p: L(`<b>/send &lt;код на Ани&gt;</b>, нов ред, поканата. Или без бот — през всеки канал. <b>Telegram вижда текста на поканата.</b>`, `<b>/send &lt;Ani's code&gt;</b>, new line, the invitation. Or skip the bot and use any channel. <b>Telegram sees the invitation text.</b>`), arrow: "Telegram",
        dev: [{ w: "A", h: "Telegram", html: `<div class="bub tg">${L("Твоят код", "Your code")}: MTIzNDU2</div>` },
              { w: "B", h: "Telegram", html: `<div class="bub me tg">/send MTIzNDU2<br>p2p1:AAECAwQFBgcI…</div><div class="bub tg">${L("Поканата е изпратена.", "Invitation sent.")}</div>` }] },
      { t: L("Ани я поставя в приложението", `${nm("A")} pastes it into the app`),
        p: L(`Ботът препраща поканата и я трие след бутона „Копирах — изтрий“ (най-много 10 минути). Ани отговаря със своя покана по същия път.`, `The bot forwards the invitation and deletes it once ${nm("A")} taps “Copied — delete” (10 minutes at most). ${nm("A")} answers with her own invitation the same way.`),
        dev: [{ w: "A", h: T("newContact"), html: `<div class="btn g">${T("scanInv")}</div><div class="lab">${L("Постави", "Paste")}</div><div class="item sel" style="font:500 10px Mono">p2p1:AAECAwQFBgcI…</div><div class="btn">${T("pasteCode").split("? ")[1]}</div>` },
              { w: "B", h: "Telegram", html: `<div class="bub tg">${L("Поканата е изпратена.", "Invitation sent.")}</div>` }] },
    ] },
  ];

  const frames = [];
  frames.push({ kind: "intro" });
  methods.forEach((m) => m.steps.forEach((s, k) => frames.push({ kind: "step", m, s, k, total: m.steps.length })));
  frames.push({ kind: "safety" });
  frames.push({ kind: "end" });
  return { frames, T, L, nm };
}


function pageHtml(lang, f) {
  const { T, L, nm } = build(lang);
  const dots = (cur, done) => `<div class="dots">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<i class="${n === cur ? "on" : n < done ? "done" : ""}">${n}</i>`).join("")}</div>`;
  const top = (cur, done) => `<div class="top"><b>${T("brand")} · ${L("как се свързват двама", "how two people connect")}</b>${dots(cur, done)}</div>`;
  if (f.kind === "intro") {
    const list = lang === "bg"
      ? [["QR лице в лице", "два QR кода, без сървър"], ["Кратък код", "5 знака и 3 думи, отдалеч"], ["Bluetooth", "само в приложението"], ["QR + звук", "отговорът се чува"], ["QR + светлина", "отговорът се вижда"], ["Общ приятел", "запознава ви трети човек"], ["Telegram бот / копирана покана", "отдалеч, през какъвто канал искате"]]
      : [["QR, face to face", "two QR codes, no server"], ["Short code", "5 characters and 3 words, remote"], ["Bluetooth", "app only"], ["QR + sound", "the reply is heard"], ["QR + light", "the reply is seen"], ["Mutual friend", "a third person introduces you"], ["Telegram bot / copied invitation", "remote, over any channel you like"]];
    return `<!doctype html><meta charset=utf-8><style>${css}</style>${top(0, 0)}
    <div class="intro"><h1>${T("title7")}</h1><div class="sub">${T("sub7")}</div>
    <div class="meth">${list.map(([a, b], n) => `<div><b>${n + 1}</b><span>${a}<small>${b}</small></span></div>`).join("")}</div>
    <div class="foot">${L("След всеки начин двамата <b>сравняват 12 думи</b>, за да са сигурни, че никой не е по средата.", "After any method both sides <b>compare 12 words</b> to be sure nobody is in the middle.")}</div></div>`;
  }
  if (f.kind === "end") {
    return `<!doctype html><meta charset=utf-8><style>${css}</style>${top(0, 8)}
    <div class="end"><div class="big"></div><h1>${T("connected")}</h1><p>${L("Съобщенията вървят директно между устройствата: шифровани от край до край, без сървър за съобщения.", "Messages go straight between the devices: end-to-end encrypted, no message server.")}</p></div>`;
  }
  const lefts2 = [50, 460], w2 = 210;
  let stage = "", capT, capP, pill, stepLab;
  if (f.kind === "safety") {
    const mk = (k) => `<div class="who" style="left:${lefts2[k]}px;width:${w2}px"><span class="av" style="background:${people[k ? "B" : "A"][1]}">${people[k ? "B" : "A"][2]}</span>${nm(k ? "B" : "A")}</div><div class="ph" style="left:${lefts2[k]}px;width:${w2}px"><h4>${T("check")}</h4>${wordsHtml}<div class="seal"></div><div class="btn m">${T("words12")}</div></div>`;
    stage = mk(0) + mk(1) + `<div class="arr" style="left:260px;width:200px;top:250px">${L("на глас / видео", "aloud / video")}<svg viewBox="0 0 200 14"><path d="M8 7H192M20 1L8 7l12 6M180 1l12 6-12 6" fill="none" stroke="#1f6fc4" stroke-width="2"/></svg></div>`;
    capT = L("След всеки начин: сравнете 12-те думи", "After any method: compare the 12 words");
    capP = L("Четете ги на глас или по видео, <b>по друг канал</b>. Съвпадат ли — натиснете „Думите съвпадат“. Не съвпаднат ли, някой е по средата.", "Read them aloud or on video, <b>over a different channel</b>. If they match, tap “The words match”. If not, someone is in the middle.");
    pill = `<span>${L("Общо за всички начини", "Common to all methods")}</span>`; stepLab = "";
    return `<!doctype html><meta charset=utf-8><style>${css}</style>${top(0, 8)}<div class="pill">${pill}<em>${stepLab}</em></div>${stage}<div class="cap"><h3>${capT}</h3><p>${capP}</p></div>`;
  }
  const { m, s, k, total } = f;
  const three = !!s.three;
  const lefts = three ? [14, 276, 538] : lefts2, w = three ? 168 : w2;
  s.dev.forEach((d, j) => {
    const lap = d.lap;
    const wd = lap ? 232 : w, lf = lap ? lefts[j] - 11 : lefts[j];
    stage += `<div class="who" style="left:${lf}px;width:${wd}px"><span class="av" style="background:${people[d.w][1]}">${people[d.w][2]}</span>${nm(d.w)}</div>
    <div class="ph${lap ? " lap" : ""}" style="left:${lf}px;width:${wd}px"><h4>${d.h}</h4>${d.html}</div>${lap ? `<div class="base" style="left:${lf - 8}px;width:${wd + 16}px"></div>` : ""}`;
  });
  if (three) {
    stage += [[182, 276], [444, 538]].map(([a, b]) => `<div class="link" style="left:${a}px;width:${b - a}px;top:270px"></div>`).join("")
      + [[182, 276], [444, 538]].map(([a, b]) => `<div class="linklab" style="left:${a}px;width:${b - a}px;top:242px">${L("шифр. връзка", "encrypted link")}</div>`).join("");
    if (k === 1) stage += `<div class="arr" style="left:206px;width:260px;top:330px;display:none"></div>`;
  } else if (s.arrow) {
    const left = /^←|←/.test(s.arrow) && !/→/.test(s.arrow);
    const lab = s.arrow.replace(/[←→]\s?|\s?[←→]/g, "").trim();
    stage += `<div class="arr" style="left:260px;width:200px;top:240px">${lab}<svg viewBox="0 0 200 14"><path d="${left ? "M192 7H8M20 1L8 7l12 6" : "M8 7H192M180 1l12 6-12 6"}" fill="none" stroke="#1f6fc4" stroke-width="2"/></svg></div>`;
  }
  if (s.srv) stage += `<div class="srv" style="left:268px;width:184px;top:226px">${s.srv.l}<small>${s.srv.s}</small></div>`;
  return `<!doctype html><meta charset=utf-8><style>${css}</style>${top(m.n, m.n)}
  <div class="pill"><span>${m.n} · ${m.name}</span><em>${T("stepWord")} ${k + 1} / ${total}</em></div>${stage}
  <div class="cap"><h3>${s.t}</h3><p>${s.p}</p></div>`;
}

const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox", "--allow-file-access-from-files", "--force-color-profile=srgb"] });
for (const lang of LANGS) {
  const { frames } = build(lang);
  const dir = join(WORK, lang);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: lang === "bg" ? "bg-BG" : "en-GB" });
  const pg = await ctx.newPage();
  for (let i = 0; i < frames.length; i++) {
    const f = join(dir, `f${String(i + 1).padStart(2, "0")}.html`);
    writeFileSync(f, pageHtml(lang, frames[i], i));
    await pg.goto(pathToFileURL(f).href);
    await pg.evaluate(async () => { await Promise.all([...document.fonts].map((x) => x.load().catch(() => {}))); await document.fonts.ready; });
    await pg.screenshot({ path: join(dir, `f${String(i + 1).padStart(2, "0")}.png`) });
  }
  await ctx.close();

  // Stills -> crossfaded GIF, one shared palette.
  const n = frames.length;
  const inputs = frames.flatMap((_, i) => ["-loop", "1", "-t", String(HOLD + FADE), "-i", join(dir, `f${String(i + 1).padStart(2, "0")}.png`)]);
  let chain = "";
  frames.forEach((_, i) => { chain += `[${i}:v]scale=${W}:${H}:flags=lanczos,format=yuv420p,fps=${FPS}[v${i}];`; });
  let prev = "[v0]";
  for (let i = 1; i < n; i++) {
    chain += `${prev}[v${i}]xfade=transition=fade:duration=${FADE}:offset=${(HOLD * i).toFixed(2)}[x${i}];`;
    prev = `[x${i}]`;
  }
  chain += `${prev}split[a][b];[a]palettegen=max_colors=${COLORS}:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  const out = join(OUT_DIR, `tutorial-connect-${lang}.gif`);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", chain, "-loop", "0", out], { stdio: "inherit" });
  console.log("wrote", out, readFileSync(out).length, "bytes;", n, "frames; words:", words.join(" "));
}
await browser.close();
