/**
 * Page template for the promo video: one HTML page, every animation is a pure function of the time `t`
 * (window.render(t)), so frames are captured deterministically. Exports html(lang, ctx).
 */
export const TIMELINE = { hook: 0, title: 4.5, a: 7, b: 11.5, c: 16, d: 19.5, e: 24.5, f: 29.5, words: 33, end: 38.5, total: 43.5 };

export const TEXT = {
  bg: {
    hook: ["Без сървър.", "Без телефонен номер.", "Само вие двамата."],
    six: "Шест начина да се свържете", way: "СПОСОБ", neu: "НОВО",
    a: ["QR лице в лице", "Покажете кода, другият го сканира"],
    b: ["Кратък код по телефона", "5 знака и 3 думи, казани на глас"],
    c: ["Bluetooth", "Директно, когато сте наблизо"],
    d: ["QR + звук", "Втората страна отговаря със звук"],
    e: ["Запознаване чрез общ приятел", "Общият приятел ви свързва, после пишете директно"],
    f: ["Покана през Telegram", "Поканата идва по чат, който вече ползвате"],
    byPhone: "по телефона", server: "СЪРВЪР", cipher: "сървърът вижда само шифър", connected: "Свързани", friend: "общ приятел",
    names: ["Ани", "Петър", "Иво"], letters: ["А", "П", "И"], tg: "Telegram", invite: "Покана", accepted: "Приета",
    words: ["След това: сравнете 12-те думи", "На глас, по друг канал"], stamp: "Потвърден контакт", match: "Думите съвпадат",
    brand: "P2P Messenger", tag: "Безплатно · Без реклами · 6 езика", plat: "Браузър · Android · Windows · Linux", bt: "Bluetooth",
  },
  en: {
    hook: ["No server.", "No phone number.", "Just the two of you."],
    six: "Six ways to connect", way: "WAY", neu: "NEW",
    a: ["Face to face with QR", "Show the code, the other one scans it"],
    b: ["A short code by phone", "5 characters and 3 words, said out loud"],
    c: ["Bluetooth", "Directly, when you are close"],
    d: ["QR + sound", "The other side answers with sound"],
    e: ["Introduced by a mutual friend", "A mutual friend links you, then you chat directly"],
    f: ["An invite via Telegram", "The invite arrives in a chat you already use"],
    byPhone: "by phone", server: "SERVER", cipher: "the server only sees ciphertext", connected: "Connected", friend: "mutual friend",
    names: ["Ana", "Peter", "Ivo"], letters: ["A", "P", "I"], tg: "Telegram", invite: "Invite", accepted: "Accepted",
    words: ["Next: compare the 12 words", "Out loud, over another channel"], stamp: "Verified contact", match: "Words match",
    brand: "P2P Messenger", tag: "Free · No ads · 6 languages", plat: "Browser · Android · Windows · Linux", bt: "Bluetooth",
  },
};

const qr = (seed, size) => {
  let s = seed, out = "";
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const n = 21;
  const fin = (x, y) => (x < 7 && y < 7) || (x > n - 8 && y < 7) || (x < 7 && y > n - 8);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fin(x, y) && r() > 0.5) out += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`;
  for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) out += `<rect x="${fx}" y="${fy}" width="7" height="7" rx="1"/><rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" rx=".6" fill="#fff"/><rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx=".4"/>`;
  return `<svg viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" fill="#0b1424">${out}</svg>`;
};

const I = {
  lock: `<svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"><rect x="13" y="22" width="22" height="16" rx="3"/><path class="shk" d="M18 22v-5a6 6 0 0 1 12 0v5"/><circle cx="24" cy="30" r="1.6" fill="#fff"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  bt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11"/></svg>`,
  call: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>`,
  plane: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.5 3.5 2.8 10.9c-.9.4-.9 1.2 0 1.5l4.6 1.5 1.8 5.4c.2.6.5.7 1 .2l2.4-2.3 4.7 3.5c.9.5 1.5.2 1.7-.9l3-16c.3-1.3-.5-1.9-1.5-1.4zM8.6 13.3l9.6-6c.5-.3.9-.1.5.2l-7.8 7.2-.3 3.6z"/></svg>`,
  seal: (id) => `<svg viewBox="0 0 48 48"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6cc4ff"/><stop offset="1" stop-color="#ff4fb0"/></linearGradient></defs><circle cx="24" cy="24" r="19" fill="url(#${id})"/><circle cx="24" cy="24" r="14.5" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2" stroke-dasharray="2 2.6"/><path d="M17 22.5h14v10.5H17z M19.8 22.5v-3.2a4.2 4.2 0 0 1 8.4 0v3.2" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>`,
};

export function html(lang, ctx) {
  const L = TEXT[lang];
  const fonts = ctx.fonts;
  const phone = (id, who, left, top = 190, body = "") => `<div class="ph" id="${id}" style="left:${left - 108}px;top:${top}px">
    <i class="nt"></i><div class="hdr"><i class="av ${who ? "m" : "s"}">${L.letters[who]}</i><b>${L.names[who]}</b></div>
    <div class="scr">${body}</div></div>`;
  const head = (k, i, neu) => `<div class="head"><div class="kick" id="${k}-k">${L.way} ${i} / 6</div><h2 id="${k}-h">${L[k][0]}${neu ? `<u class="new" id="${k}-n">${L.neu}</u>` : ""}</h2><p id="${k}-p">${L[k][1]}</p></div>`;
  const idle = `<div class="lay idle" data-l="idle">${`<div class="ic">${I.seal("gi" + Math.random().toString(36).slice(2, 6))}</div>`}</div>`;
  const okl = () => `<div class="lay okl" data-l="ok"><div class="okc">${I.check}</div><span>${L.connected}</span></div>`;
  const qrl = (seed) => `<div class="lay qrl" data-l="qr"><div class="qrc">${qr(seed, 150)}</div></div>`;
  const caml = (seed) => `<div class="lay caml" data-l="cam"><div class="vf"><div class="dim">${qr(seed, 140)}</div><b class="c1"></b><b class="c2"></b><b class="c3"></b><b class="c4"></b><i class="sl" data-l="scan"></i></div></div>`;
  const wordsHtml = ctx.words.map((w, i) => `<div class="chip w" id="w${i}"><small>${String(i + 1).padStart(2, "0")}</small>${w}</div>`).join("");
  const dots = [1, 2, 3, 4, 5, 6].map((n) => `<i id="dt${n}"></i>`).join("");
  const nodes = [1, 2, 3, 4, 5, 6].map((n) => `<div class="node" id="nd${n}">${n}</div>`).join("");
  const bars = Array.from({ length: 26 }, (_, i) => `<i id="eq${i}"></i>`).join("");
  const arcs = Array.from({ length: 5 }, (_, i) => `<path id="arc${i}" fill="none" stroke="url(#arcg)" stroke-width="5" stroke-linecap="round"/>`).join("");
  const rings = Array.from({ length: 4 }, (_, i) => `<i class="ring" id="rg${i}"></i>`).join("");

  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><style>
${fonts}
*{box-sizing:border-box;margin:0;padding:0}
:root{--a:#6cc4ff;--b:#ff4fb0;--ink:#070b16;--text:#d9e4f3;--muted:#9fb0c8;--line:rgba(160,190,230,.22)}
html,body{width:1280px;height:720px;overflow:hidden;background:var(--ink)}
body{font-family:"Plex Sans",sans-serif;color:var(--text);position:relative}
.bgl{position:absolute;inset:0;background:var(--ink)}
.blob{position:absolute;width:1000px;height:1000px;border-radius:50%}
.blob.a{background:radial-gradient(closest-side,rgba(60,150,230,.34),rgba(60,150,230,0))}
.blob.b{background:radial-gradient(closest-side,rgba(230,50,160,.30),rgba(230,50,160,0))}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(160,190,230,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(160,190,230,.055) 1px,transparent 1px);background-size:48px 48px;-webkit-mask-image:radial-gradient(ellipse at center,#000 30%,transparent 80%)}
.sc{position:absolute;inset:0;display:none}
.grad{background:linear-gradient(90deg,var(--a),var(--b));-webkit-background-clip:text;background-clip:text;color:transparent}
h1,h2{font:500 60px/1.1 "Plex Serif",serif;color:#fff;letter-spacing:-.01em}
.head{position:absolute;left:64px;right:64px;top:44px;text-align:center}
.kick{font:500 17px "Plex Mono",monospace;letter-spacing:.22em;color:var(--a)}
.head h2{font-size:48px;margin-top:10px;white-space:nowrap}
.head p{font:400 24px "Plex Sans",sans-serif;color:var(--muted);margin-top:10px}
.new{display:inline-block;vertical-align:10px;margin-left:16px;font:600 17px "Plex Mono",monospace;letter-spacing:.18em;text-decoration:none;color:#fff;background:linear-gradient(90deg,#ff4fb0,#c21d86);padding:7px 13px;border-radius:8px;box-shadow:0 0 26px rgba(255,79,176,.6)}
.ph{position:absolute;width:216px;height:430px;border-radius:38px;background:#0a1322;border:2px solid rgba(190,215,250,.34);box-shadow:0 34px 70px -24px rgba(0,0,0,.85),0 0 60px -10px rgba(108,196,255,.18);z-index:3}
.nt{position:absolute;top:10px;left:50%;width:62px;height:16px;margin-left:-31px;border-radius:10px;background:#02050c}
.hdr{position:absolute;top:34px;left:18px;right:18px;display:flex;align-items:center;gap:10px;font:600 19px "Plex Sans";color:#fff}
.av{width:28px;height:28px;border-radius:50%;font:600 15px/28px "Plex Sans";text-align:center;color:#06101e;font-style:normal;background:var(--a)}
.av.m{background:var(--b)}
.scr{position:absolute;left:12px;right:12px;top:78px;bottom:14px;border-radius:20px;background:#0f1b30;overflow:hidden;border:1px solid rgba(160,190,230,.12)}
.lay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;opacity:0}
.idle .ic{width:74px;height:74px;opacity:.5}
.qrc{background:#fff;padding:10px;border-radius:14px;box-shadow:0 0 36px rgba(108,196,255,.45)}.qrc svg{display:block}
.vf{position:relative;width:150px;height:150px;overflow:hidden;border-radius:10px;background:#070d18}
.vf .dim{position:absolute;inset:5px;opacity:.55;filter:invert(.9) contrast(.8)}
.vf b{position:absolute;width:26px;height:26px;border:4px solid var(--b)}
.vf .c1{left:0;top:0;border-right:0;border-bottom:0;border-radius:8px 0 0 0}.vf .c2{right:0;top:0;border-left:0;border-bottom:0;border-radius:0 8px 0 0}
.vf .c3{left:0;bottom:0;border-right:0;border-top:0;border-radius:0 0 0 8px}.vf .c4{right:0;bottom:0;border-left:0;border-top:0;border-radius:0 0 8px 0}
.sl{position:absolute;left:0;right:0;top:0;height:4px;background:var(--b);box-shadow:0 0 18px 4px rgba(255,79,176,.8);opacity:0}
.okl{gap:12px;font:600 21px "Plex Sans";color:#fff}
.okc{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--a),var(--b));display:flex;align-items:center;justify-content:center;color:#fff;padding:14px;box-shadow:0 0 34px rgba(255,79,176,.5)}
.pill{position:absolute;z-index:5;display:flex;align-items:center;gap:12px;padding:12px 24px 12px 14px;border-radius:40px;background:rgba(15,27,48,.92);border:1px solid rgba(160,190,230,.35);font:600 23px "Plex Sans";color:#fff;white-space:nowrap;box-shadow:0 10px 40px -10px rgba(0,0,0,.7)}
.pill .okc{width:36px;height:36px;padding:8px;box-shadow:none}
.mono{font:500 17px "Plex Mono",monospace;letter-spacing:.16em;color:var(--muted)}
.dots{position:absolute;left:0;right:0;bottom:34px;display:flex;gap:12px;justify-content:center;opacity:0}
.dots i{width:12px;height:12px;border-radius:6px;background:rgba(160,190,230,.28)}
.dots i.on{width:40px;background:linear-gradient(90deg,var(--a),var(--b))}
.big{font:500 32px "Plex Mono",monospace;letter-spacing:.2em;color:#fff;text-align:center}
.chip{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:rgba(15,27,48,.85);border-radius:12px;padding:6px 14px;font:500 22px "Plex Mono",monospace;color:#fff}
.chip small{font:500 15px "Plex Mono",monospace;color:var(--b)}
.w{position:absolute;width:256px;height:70px;justify-content:center;font-size:27px;gap:12px}
.mid{position:absolute;left:438px;width:404px;text-align:center}
.cph{position:absolute;left:0;right:0;text-align:center}
.lk{position:absolute;width:82px;height:82px;left:50%;margin-left:-41px}
.lk svg{width:100%;height:100%;filter:drop-shadow(0 0 16px rgba(255,79,176,.7))}
.ring{position:absolute;border-radius:50%;border:4px solid var(--a);left:0;top:0}
.node{width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 26px "Plex Serif";color:#06101e;background:linear-gradient(135deg,var(--a),var(--b));position:absolute;top:0}
.avt{z-index:2;position:absolute;width:128px;height:128px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:500 58px "Plex Serif";color:#06101e;border:3px solid rgba(255,255,255,.7)}
.lab{position:absolute;width:260px;text-align:center;font:600 25px "Plex Sans";color:#fff}
svg{overflow:visible}
</style>
<div class="bgl"><i class="blob a" id="bl1"></i><i class="blob b" id="bl2"></i><div class="grid"></div></div>

<section class="sc" id="sc-hook">
  <div style="position:absolute;left:0;right:0;top:150px;text-align:center">
    <h1 id="h1" style="font-size:80px;margin-bottom:14px">${L.hook[0]}</h1>
    <h1 id="h2" style="font-size:80px;margin-bottom:14px">${L.hook[1]}</h1>
    <h1 id="h3" class="grad" style="font-size:80px;padding-bottom:10px">${L.hook[2]}</h1>
  </div>
  <i id="hd1" class="avt" style="left:376px;top:520px;width:76px;height:76px;background:var(--a);font-size:32px;border-width:2px">${L.letters[0]}</i>
  <i id="hd2" class="avt" style="left:828px;top:520px;width:76px;height:76px;background:var(--b);font-size:32px;border-width:2px">${L.letters[1]}</i>
  <i id="hline" style="position:absolute;left:452px;top:556px;width:376px;height:4px;border-radius:2px;background:linear-gradient(90deg,var(--a),var(--b));transform-origin:left;box-shadow:0 0 18px rgba(255,79,176,.6)"></i>
  <div id="hlock" class="lk" style="top:507px;width:60px;height:60px;margin-left:-30px;left:640px;background:#0a1322;border-radius:50%;padding:8px;border:2px solid var(--b)">${I.lock}</div>
</section>

<section class="sc" id="sc-title">
  <div style="position:absolute;left:0;right:0;top:215px;text-align:center">
    <div class="kick" id="t-k" style="font-size:19px">${L.brand.toUpperCase()}</div>
    <h1 id="t-h" style="font-size:${lang === "bg" ? 74 : 86}px;margin-top:20px;white-space:nowrap">${L.six}</h1>
  </div>
  <div id="nodes" style="position:absolute;left:${640 - 210}px;top:450px;width:420px;height:60px">${nodes}</div>
</section>

<section class="sc" id="sc-a">${head("a", 1)}
  ${phone("pa1", 0, 330, 190, idle + qrl(7) + caml(11) + okl())}
  ${phone("pa2", 1, 950, 190, idle + caml(7) + qrl(13) + okl())}
  <div class="pill" id="a-pill" style="left:640px;top:370px"><div class="okc">${I.check}</div>${L.connected}</div>
</section>

<section class="sc" id="sc-b">${head("b", 2)}
  ${phone("pb1", 0, 330, 190, `<div class="lay" data-l="main" style="opacity:1;justify-content:flex-start;padding-top:26px;gap:14px"><div class="mono" style="font-size:14px">${lang === "bg" ? "КОД" : "CODE"}</div><div class="big" id="b-code" style="font-size:36px;letter-spacing:.14em;margin-left:.14em">K7M2Q</div><div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;width:100%;align-items:center"><span class="chip" id="bw1">maple</span><span class="chip" id="bw2">orbit</span><span class="chip" id="bw3">river</span></div></div>`)}
  ${phone("pb2", 1, 950, 190, `<div class="lay" data-l="main" style="opacity:1;justify-content:flex-start;padding-top:26px;gap:14px"><div class="mono" style="font-size:14px">${lang === "bg" ? "КОД" : "CODE"}</div><div class="big" id="b-in" style="font-size:36px;letter-spacing:.14em;margin-left:.14em;height:44px"></div><div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;width:100%;align-items:center"><span class="chip" id="bi1" style="opacity:0">maple</span><span class="chip" id="bi2" style="opacity:0">orbit</span><span class="chip" id="bi3" style="opacity:0">river</span></div></div>`)}
  <div class="mid" id="b-m1" style="top:290px"><div style="width:88px;height:88px;margin:0 auto;color:var(--a)">${I.call}</div><div class="mono" style="font-size:20px;margin-top:6px;color:var(--a)">${L.byPhone}</div>
    <div id="b-arrow" style="position:relative;margin:22px auto 0;width:300px;height:6px"><i style="position:absolute;inset:0;border-top:4px dashed rgba(108,196,255,.7)"></i><i id="b-dot" style="position:absolute;top:-8px;left:0;width:20px;height:20px;border-radius:50%;background:var(--a);box-shadow:0 0 18px var(--a)"></i></div></div>
  <div class="mid" id="b-m2" style="top:238px"><div class="lk" id="b-lock" style="top:0">${I.lock}</div>
    <div style="position:absolute;top:104px;left:0;right:0"><div class="mono" style="font-size:16px;color:var(--b)">${L.server}</div>
    <div class="chip" id="b-cph" style="margin-top:8px;width:340px;justify-content:center;font-size:20px;letter-spacing:.06em;color:var(--a);overflow:hidden">x</div>
    <div style="font:600 26px/1.25 'Plex Sans';color:#fff;margin-top:22px;padding:0 6px">${L.cipher}</div></div></div>
</section>

<section class="sc" id="sc-c">${head("c", 3)}
  <div id="rings" style="position:absolute;left:0;top:0;width:1280px;height:720px;z-index:1">${rings}</div>
  ${phone("pc1", 0, 450, 190, idle + `<div class="lay" data-l="bt" style="gap:12px"><div style="width:64px;height:64px;color:var(--a)">${I.bt}</div><div class="mono" style="font-size:15px">${L.bt}</div></div>` + okl())}
  ${phone("pc2", 1, 830, 190, idle + `<div class="lay" data-l="bt" style="gap:12px"><div style="width:64px;height:64px;color:var(--b)">${I.bt}</div><div class="mono" style="font-size:15px">${L.bt}</div></div>` + okl())}
  <div id="btc" style="position:absolute;left:640px;top:405px;width:92px;height:92px;margin:-46px 0 0 -46px;border-radius:50%;background:#0a1322;border:3px solid var(--a);color:var(--a);padding:20px;z-index:4;box-shadow:0 0 40px rgba(108,196,255,.6)">${I.bt}</div>
  <svg id="btl" style="position:absolute;left:0;top:0;width:1280px;height:720px;z-index:2"><line id="btline" x1="558" y1="405" x2="722" y2="405" stroke="url(#arcg)" stroke-width="5" stroke-linecap="round" stroke-dasharray="164" stroke-dashoffset="164"/></svg>
</section>

<section class="sc" id="sc-d">${head("d", 4, true)}
  <svg id="arcsvg" style="position:absolute;left:0;top:0;width:1280px;height:720px;z-index:2"><defs><linearGradient id="arcg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6cc4ff"/><stop offset="1" stop-color="#ff4fb0"/></linearGradient></defs>${arcs}</svg>
  ${phone("pd1", 0, 330, 190, idle + qrl(7) + `<div class="lay" data-l="snd" style="gap:14px"><div class="eqm" id="eqm" style="display:flex;gap:5px;align-items:center;height:70px">${Array.from({ length: 9 }, (_, i) => `<i id="em${i}" style="width:8px;border-radius:4px;background:var(--a)"></i>`).join("")}</div><div class="mono" style="font-size:15px;color:var(--a)">))) ♪</div></div>` + okl())}
  ${phone("pd2", 1, 950, 190, idle + caml(7) + `<div class="lay" data-l="snd" style="gap:14px"><div style="display:flex;gap:5px;align-items:center;height:70px">${Array.from({ length: 9 }, (_, i) => `<i id="ek${i}" style="width:8px;border-radius:4px;background:var(--b)"></i>`).join("")}</div><div class="mono" style="font-size:15px;color:var(--b)">♪ )))</div></div>` + okl())}
  <div id="eq" style="position:absolute;left:520px;top:515px;width:240px;height:70px;display:flex;gap:6px;align-items:center;justify-content:center;z-index:2">${bars}</div>
  <div class="pill" id="d-pill" style="left:640px;top:350px"><div class="okc">${I.check}</div>${L.connected}</div>
</section>

<section class="sc" id="sc-e">${head("e", 5, true)}
  <svg id="esvg" style="position:absolute;left:0;top:0;width:1280px;height:720px;z-index:1">
    <defs><linearGradient id="eg" gradientUnits="userSpaceOnUse" x1="300" y1="0" x2="980" y2="0"><stop offset="0" stop-color="#6cc4ff"/><stop offset="1" stop-color="#ff4fb0"/></linearGradient></defs>
    <line id="eBA" x1="640" y1="320" x2="330" y2="520" stroke="rgba(190,215,250,.55)" stroke-width="4" stroke-dasharray="10 9" stroke-linecap="round"/>
    <line id="eBC" x1="640" y1="320" x2="950" y2="520" stroke="rgba(190,215,250,.55)" stroke-width="4" stroke-dasharray="10 9" stroke-linecap="round"/>
    <line id="eAC" x1="640" y1="520" x2="640" y2="520" stroke="url(#eg)" stroke-width="8" stroke-linecap="round" style="filter:drop-shadow(0 0 10px rgba(255,79,176,.7))"/>
  </svg>
  <div class="avt" id="eA" style="left:266px;top:456px;background:var(--a)">${L.letters[0]}</div>
  <div class="avt" id="eC" style="left:886px;top:456px;background:var(--b)">${L.letters[1]}</div>
  <div class="avt" id="eB" style="left:576px;top:256px;background:linear-gradient(135deg,#ffd27a,#ff9d5c)">${L.letters[2]}</div>
  <div class="lab" id="eAl" style="left:200px;top:600px">${L.names[0]}</div>
  <div class="lab" id="eCl" style="left:820px;top:600px">${L.names[1]}</div>
  <div class="lab" id="eBl" style="left:510px;top:392px;font-size:22px;color:var(--muted)">${L.names[2]} · ${L.friend}</div>
  <div class="lk" id="eLock" style="left:640px;top:480px;margin-left:-32px;width:64px;height:64px;background:#0a1322;border-radius:50%;padding:10px;border:2px solid var(--b);z-index:3">${I.lock}</div>
</section>

<section class="sc" id="sc-f">${head("f", 6)}
  ${phone("pf1", 0, 300, 190, idle + `<div class="lay" data-l="chat" style="gap:12px;justify-content:flex-start;padding-top:24px"><div class="chip" style="gap:10px;font:600 17px 'Plex Sans';border-radius:16px;padding:10px 14px"><span style="width:20px;height:20px;color:var(--a)">${I.plane}</span>${L.tg}</div><div class="chip" id="f-inv" style="font:600 18px 'Plex Sans';background:linear-gradient(135deg,var(--a),#3d7fd1);color:#06101e;border:0;border-radius:16px 16px 4px 16px;padding:12px 16px">${L.invite}</div></div>` + okl())}
  ${phone("pf2", 1, 980, 190, idle + `<div class="lay" data-l="chat" style="gap:12px;justify-content:flex-start;padding-top:24px"><div class="chip" style="gap:10px;font:600 17px 'Plex Sans';border-radius:16px;padding:10px 14px"><span style="width:20px;height:20px;color:var(--a)">${I.plane}</span>${L.tg}</div><div class="chip" id="f-inv2" style="font:600 18px 'Plex Sans';background:rgba(15,27,48,.95);border-radius:16px 16px 16px 4px;padding:12px 16px">${L.invite}</div></div>` + okl())}
  <div id="env" style="position:absolute;left:0;top:0;width:150px;height:110px;z-index:6">
    <svg viewBox="0 0 150 110" width="150" height="110"><defs><linearGradient id="eng" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7fbff"/><stop offset="1" stop-color="#bcd3ee"/></linearGradient></defs>
      <rect x="4" y="22" width="142" height="84" rx="10" fill="url(#eng)"/>
      <polygon id="flap" points="4,28 146,28 75,70" fill="#dbe8f7" stroke="#9db7d8" stroke-width="1.5" stroke-linejoin="round"/>
      <g id="eseal"><circle cx="75" cy="70" r="19" fill="#d41b7f"/><circle cx="75" cy="70" r="14" fill="none" stroke="rgba(255,255,255,.6)" stroke-dasharray="2 2.6"/><g transform="translate(60 55) scale(.62)" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="22" width="22" height="16" rx="3"/><path d="M18 22v-5a6 6 0 0 1 12 0v5"/></g></g>
    </svg></div>
  <div class="pill" id="f-pill" style="left:640px;top:535px;gap:10px;padding:12px 22px 12px 14px"><span style="width:30px;height:30px;color:var(--a)">${I.plane}</span>${L.tg}</div>
</section>

<section class="sc" id="sc-words">
  <div style="position:absolute;left:64px;right:64px;top:48px;text-align:center">
    <h1 id="wt" style="font-size:${lang === "bg" ? 52 : 56}px;white-space:nowrap">${L.words[0]}</h1>
    <p id="ws" style="font:400 26px 'Plex Sans';color:var(--muted);margin-top:12px">${L.words[1]}</p></div>
  <div id="wgrid">${wordsHtml}</div>
  <div id="stamp" style="position:absolute;left:0;right:0;top:545px;display:flex;justify-content:center;align-items:center;gap:22px;">
    <div id="seal" style="width:92px;height:92px">${I.seal("gs")}</div>
    <div style="text-align:left"><div style="font:500 36px 'Plex Serif';color:#fff">${L.stamp}</div><div class="mono" style="font-size:18px;color:var(--b);margin-top:6px">${L.match.toUpperCase()}</div></div></div>
</section>

<section class="sc" id="sc-end">
  <div id="eseal2" style="position:absolute;left:560px;top:90px;width:160px;height:160px">${I.seal("ge")}</div>
  <i id="erg" style="position:absolute;left:560px;top:90px;width:160px;height:160px;border-radius:50%;border:3px solid var(--b)"></i>
  <div style="position:absolute;left:0;right:0;top:292px;text-align:center">
    <div class="kick" id="e1" style="font-size:20px">${L.brand.toUpperCase()}</div>
    <h1 id="e2" class="grad" style="font-size:96px;margin:14px 0 22px;padding-bottom:12px">dyrakarmy.online</h1>
    <div id="e3" style="font:600 36px 'Plex Sans';color:#fff">${L.tag}</div>
    <div id="e4" class="mono" style="font-size:20px;margin-top:30px">${L.plat}</div></div>
</section>
<div class="dots" id="dots">${dots}</div>

<script>
const T=${JSON.stringify(TIMELINE)};
const ORDER=["hook","title","a","b","c","d","e","f","words","end"];
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const pr=(t,a,b)=>clamp((t-a)/(b-a));
const eio=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
const eo=x=>1-Math.pow(1-x,3);
const eb=x=>{const c=1.70158;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)};
const $=id=>document.getElementById(id);
const put=(el,o)=>{if(!el)return;const x=o.x||0,y=o.y||0,s=o.s===undefined?1:o.s,r=o.r||0;el.style.transform="translate("+x+"px,"+y+"px) scale("+s+") rotate("+r+"deg)";if(o.o!==undefined)el.style.opacity=o.o};
const ap=(id,lt,a,d,dy=26)=>{const p=eo(pr(lt,a,a+d));put($(id),{y:(1-p)*dy,o:p})};
const lay=(ph,name,o)=>{const e=$(ph).querySelector('[data-l="'+name+'"]');if(e)e.style.opacity=o};
const head=(k,lt)=>{ap(k+"-k",lt,.1,.45,14);ap(k+"-h",lt,.2,.55,22);ap(k+"-p",lt,.5,.5,16);const n=$(k+"-n");if(n){const q=eb(pr(lt,.7,1.2));n.style.transform="scale("+q+")";n.style.boxShadow="0 0 "+(22+14*Math.sin(lt*6))+"px rgba(255,79,176,.65)"}};
const slide=(a,b,lt,s,e,dx=140)=>{const p=eo(pr(lt,s,e));put($(a),{x:-(1-p)*dx,o:p});put($(b),{x:(1-p)*dx,o:p})};
const idleOf=(ph,others)=>{lay(ph,"idle",1-clamp(others))};
const rnd=n=>{const x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x)};
const HEX="0123456789abcdef";

const F={};
F.hook=lt=>{
  ap("h1",lt,.25,.7,40);ap("h2",lt,1.2,.7,40);ap("h3",lt,2.2,.8,40);
  const d=eb(pr(lt,2.5,3.1));put($("hd1"),{s:d,o:pr(lt,2.5,2.8)});put($("hd2"),{s:d,o:pr(lt,2.5,2.8)});
  const l=eio(pr(lt,3.0,3.8));$("hline").style.transform="scaleX("+l+")";$("hline").style.opacity=pr(lt,3.0,3.1);
  const k=eb(pr(lt,3.7,4.2));put($("hlock"),{s:k,o:pr(lt,3.7,3.9)});
  $("hlock").style.marginTop="0px";
};
F.title=lt=>{
  ap("t-k",lt,.05,.5,14);ap("t-h",lt,.15,.7,30);
  for(let i=1;i<=6;i++){const p=eb(pr(lt,.7+i*.12,1.1+i*.12));const e=$("nd"+i);e.style.left=((i-1)*72)+"px";put(e,{s:p,o:clamp(p)})}
};
F.a=lt=>{
  head("a",lt);slide("pa1","pa2",lt,.1,.8,150);
  const qrA=pr(lt,.7,.95)*(1-pr(lt,1.9,2.1)),camB=pr(lt,.7,.95)*(1-pr(lt,1.9,2.1));
  const camA=pr(lt,2.0,2.2)*(1-pr(lt,3.2,3.4)),qrB=pr(lt,2.0,2.2)*(1-pr(lt,3.2,3.4));
  const ok=pr(lt,3.3,3.55);
  lay("pa1","qr",qrA);lay("pa2","cam",camB);lay("pa1","cam",camA);lay("pa2","qr",qrB);lay("pa1","ok",ok);lay("pa2","ok",ok);
  lay("pa1","idle",1-clamp(qrA+camA+ok));lay("pa2","idle",1-clamp(camB+qrB+ok));
  const sB=$("pa2").querySelector('[data-l="scan"]'),sA=$("pa1").querySelector('[data-l="scan"]');
  const f1=pr(lt,1.0,1.8),f2=pr(lt,2.45,3.2);
  sB.style.top=(eio(f1)*146)+"px";sB.style.opacity=(f1>0&&f1<1)?1:0;
  sA.style.top=(eio(f2)*146)+"px";sA.style.opacity=(f2>0&&f2<1)?1:0;
  const pp=eb(pr(lt,3.55,4.0));put($("a-pill"),{x:-$("a-pill").offsetWidth/2,y:0,s:pp,o:clamp(pp)});$("a-pill").style.marginLeft="0";
};
F.b=lt=>{
  head("b",lt);slide("pb1","pb2",lt,.1,.8,150);
  const code="K7M2Q";const n=Math.floor(pr(lt,.7,1.3)*5.001);$("b-code").style.opacity=pr(lt,.55,.7)||0;
  $("b-code").textContent=code;$("b-code").style.opacity=1;
  ["bw1","bw2","bw3"].forEach((id,i)=>{const p=eo(pr(lt,.7+i*.28,1.0+i*.28));put($(id),{y:(1-p)*16,o:p})});
  // empty code display until typed
  $("b-code").innerHTML=code.split("").map((c,i)=>'<span style="opacity:'+(i<Math.floor(pr(lt,.7,1.3)*5+0.999)?1:.1)+'">'+c+'</span>').join("");
  // arrow + handset
  const m1=pr(lt,1.5,1.8)*(1-pr(lt,2.6,2.85));put($("b-m1"),{x:0,y:0,o:m1});
  const dp=eio(pr(lt,1.7,2.5));$("b-dot").style.left=(dp*280)+"px";
  // typing on right
  const k=Math.floor(pr(lt,2.0,2.5)*5.001);$("b-in").textContent=code.slice(0,k);
  ["bi1","bi2","bi3"].forEach((id,i)=>{const p=eo(pr(lt,2.3+i*.12,2.5+i*.12));put($(id),{y:(1-p)*16,o:p})});
  // lock + cipher
  const m2=pr(lt,2.85,3.15);put($("b-m2"),{x:0,y:(1-eo(m2))*20,o:m2});
  const sh=$("b-lock").querySelector(".shk");const c=eb(pr(lt,2.95,3.4));sh.style.transform="translateY("+((1-c)*-7)+"px)";
  let s="";for(let i=0;i<22;i++){s+=HEX[Math.floor(rnd(i*7+Math.floor(lt*12)*13)*16)];if(i%2)s+=i<21?"·":""}
  $("b-cph").textContent=s;
  // fade left/right fields a little after secured
  put($("b-lock"),{s:1+.04*Math.sin(lt*5),o:1});
};
F.c=lt=>{
  head("c",lt);slide("pc1","pc2",lt,.1,.8,110);
  const a=pr(lt,.8,1.0)*(1-pr(lt,2.3,2.5));lay("pc1","bt",a);lay("pc2","bt",a);
  const ok=pr(lt,2.5,2.8);lay("pc1","ok",ok);lay("pc2","ok",ok);lay("pc1","idle",1-clamp(a+ok));lay("pc2","idle",1-clamp(a+ok));
  const bp=eb(pr(lt,.5,1.0));put($("btc"),{s:bp,o:clamp(bp)});
  for(let i=0;i<4;i++){const ph=((lt-.9-i*.55)%2.2+2.2)%2.2/2.2;const on=lt>.9&&lt<2.9?1:0;const r=60+ph*155;const e=$("rg"+i);e.style.width=r*2+"px";e.style.height=r*2+"px";e.style.left=(640-r)+"px";e.style.top=(405-r)+"px";e.style.opacity=on*(1-ph)*.75*pr(lt,.9+i*.55,1.1+i*.55>2.9?9:1.1+i*.55);e.style.borderColor=i%2?"#ff4fb0":"#6cc4ff"}
  const l=eio(pr(lt,2.2,2.9));$("btline").style.strokeDashoffset=164*(1-l);
};
F.d=lt=>{
  head("d",lt);slide("pd1","pd2",lt,.1,.8,150);
  const qrA=pr(lt,.7,.95)*(1-pr(lt,3.3,3.5)),camB=pr(lt,.7,.95)*(1-pr(lt,1.9,2.1));
  const sndB=pr(lt,1.95,2.15)*(1-pr(lt,3.3,3.5)),sndA=pr(lt,3.3,3.5)*(1-pr(lt,4.0,4.2)),ok=pr(lt,3.9,4.15);
  lay("pd1","qr",qrA*(1-sndA));lay("pd2","cam",camB);lay("pd2","snd",sndB);lay("pd1","snd",sndA);lay("pd1","ok",ok);lay("pd2","ok",ok);
  lay("pd1","idle",1-clamp(qrA+sndA+ok));lay("pd2","idle",1-clamp(camB+sndB+ok));
  const sB=$("pd2").querySelector('[data-l="scan"]');const f1=pr(lt,1.0,1.8);sB.style.top=(eio(f1)*146)+"px";sB.style.opacity=(f1>0&&f1<1)?1:0;
  // eq bars & phone bars
  const emit=lt>1.95&&lt<3.45;const A=emit?Math.min(1,pr(lt,1.95,2.1))*(1-pr(lt,3.3,3.45)):0;
  for(let i=0;i<26;i++){const h=6+A*(10+34*Math.abs(Math.sin(lt*9+i*.9)*Math.cos(lt*5.3+i*.37)));$("eq"+i).style.cssText="width:6px;border-radius:3px;height:"+h+"px;background:"+(i<13?"#6cc4ff":"#ff4fb0")+";opacity:"+(.25+.75*A)}
  for(let i=0;i<9;i++){const hk=10+(lt>1.95&&lt<3.45?36*Math.abs(Math.sin(lt*10+i*1.1)):4);$("ek"+i).style.height=hk+"px";const hm=10+(lt>3.3&&lt<4.1?34*Math.abs(Math.sin(lt*10+i*1.3)):4);$("em"+i).style.height=hm+"px"}
  // arcs from right phone to left phone
  for(let i=0;i<5;i++){const ph=(lt-2.0-i*.28)/1.35;const e=$("arc"+i);if(ph<0||ph>1||lt>3.55){e.setAttribute("d","M0 0");continue}
    const r=40+eo(ph)*330,cx=842,cy=405,a=.62-.18*ph;const x1=cx-r*Math.cos(a),y1=cy-r*Math.sin(a),y2=cy+r*Math.sin(a);
    e.setAttribute("d","M"+x1+" "+y1+" A"+r+" "+r+" 0 0 0 "+x1+" "+y2);e.setAttribute("opacity",(1-ph)*.95*Math.min(1,ph*8))}
  const pp=eb(pr(lt,4.15,4.6));put($("d-pill"),{x:-$("d-pill").offsetWidth/2,s:pp,o:clamp(pp)});
};
F.e=lt=>{
  head("e",lt);
  const pa=eb(pr(lt,.4,.95)),pc=eb(pr(lt,.55,1.1)),pb=eb(pr(lt,.2,.75));
  const base=(id,p,dx,dy)=>put($(id),{x:dx,y:dy,s:p,o:clamp(p*1.5)});
  const step=eio(pr(lt,3.4,4.3));
  base("eA",pa,0,0);base("eC",pc,0,0);
  put($("eB"),{y:-step*34,s:Math.max(0,pb)*(1-.22*step),o:clamp(pb*1.5)*(1-.55*step)});
  ["eAl","eCl"].forEach((id,i)=>put($(id),{o:pr(lt,.9+i*.1,1.2+i*.1)}));
  put($("eBl"),{y:-step*34,o:pr(lt,.7,1.0)*(1-step)});
  const l1=eio(pr(lt,1.3,1.9));const fade=1-pr(lt,3.4,4.0);
  const ba=$("eBA"),bc=$("eBC");
  ba.setAttribute("x2",640+(330-640)*l1);ba.setAttribute("y2",320+(520-320)*l1);bc.setAttribute("x2",640+(950-640)*l1);bc.setAttribute("y2",320+(520-320)*l1);
  ba.style.opacity=fade*pr(lt,1.3,1.4);bc.style.opacity=fade*pr(lt,1.3,1.4);
  // B pulse glow, then A-C line draws from the centre outward
  const ln=eio(pr(lt,2.2,3.3));const ac=$("eAC");ac.setAttribute("x1",640-ln*250);ac.setAttribute("x2",640+ln*250);ac.setAttribute("y1",520);ac.setAttribute("y2",520);ac.style.opacity=pr(lt,2.2,2.3);
  const lp=eb(pr(lt,3.2,3.7));put($("eLock"),{x:0,y:0,s:lp,o:clamp(lp)});
};
F.f=lt=>{
  head("f",lt);slide("pf1","pf2",lt,.1,.8,150);
  const inv=eo(pr(lt,.7,1.0));put($("f-inv"),{y:(1-inv)*12,o:inv});lay("pf1","idle",1-inv);lay("pf1","chat",inv*(1-pr(lt,2.9,3.1)));
  const arr=pr(lt,2.0,2.25);lay("pf2","idle",1-clamp(pr(lt,1.9,2.1)));lay("pf2","chat",pr(lt,2.1,2.3)*(1-pr(lt,2.9,3.1)));
  const inv2=eo(pr(lt,2.2,2.5));put($("f-inv2"),{y:(1-inv2)*12,o:inv2});
  const ok=pr(lt,3.0,3.25);lay("pf1","ok",ok);lay("pf2","ok",ok);
  // envelope flight
  const p=eio(pr(lt,1.0,2.1));const x=300+(980-300)*p-75,y=420-Math.sin(p*Math.PI)*90-55;
  const e=$("env");e.style.left="0px";e.style.top="0px";
  const vis=lt>1.0&&lt<2.3?1:0;const sc=1-.35*pr(lt,1.9,2.3);
  put(e,{x:x+(75*(1-sc)),y:y+(55*(1-sc))+ (lt>2.3?0:0),s:sc,r:-8+16*p,o:vis*pr(lt,1.0,1.15)*(1-pr(lt,2.1,2.3))});
  const fl=pr(lt,1.8,2.2);$("flap").setAttribute("points","4,28 146,28 75,"+(70-98*fl));$("eseal").style.opacity=1-pr(lt,1.8,2.0);
  const pp=eb(pr(lt,.5,1.0));put($("f-pill"),{x:-$("f-pill").offsetWidth/2,s:pp,o:clamp(pp)});
};
F.words=lt=>{
  ap("wt",lt,.1,.6,24);ap("ws",lt,.4,.5,14);
  for(let i=0;i<12;i++){const r=Math.floor(i/4),c=i%4;const e=$("w"+i);e.style.left=(64+(1152-4*256-3*24)/2+c*(256+24))+"px";e.style.top=(206+r*(70+22))+"px";const p=eo(pr(lt,.7+i*.12,1.1+i*.12));put(e,{y:(1-p)*20,o:p})}
  const s=eb(pr(lt,3.6,4.2));const st=$("stamp");st.style.opacity=clamp(s);$("seal").style.transform="scale("+(1.6-.6*clamp(s))+") rotate("+((1-clamp(s))*-30)+"deg)";
  $("stamp").style.transform="translateY("+((1-clamp(s))*14)+"px)";
};
F.end=lt=>{
  const s=eb(pr(lt,.1,.8));put($("eseal2"),{s:s,o:clamp(s*2)});
  const g=pr(lt,.5,2.4);const r=$("erg");r.style.transform="scale("+(1+g*1.4)+")";r.style.opacity=(1-g)*.8*pr(lt,.5,.6);
  ap("e1",lt,.5,.5,14);ap("e2",lt,.7,.7,30);ap("e3",lt,1.4,.6,18);ap("e4",lt,1.9,.6,14);
};

const DOTS={a:1,b:2,c:3,d:4,e:5,f:6};
window.render=t=>{
  $("bl1").style.transform="translate("+(-300+60*Math.sin(t*.35))+"px,"+(-420+40*Math.cos(t*.3))+"px)";
  $("bl2").style.transform="translate("+(620+60*Math.cos(t*.3))+"px,"+(180+50*Math.sin(t*.4))+"px)";
  let dotOp=0,dotIdx=0;
  ORDER.forEach((k,i)=>{
    const s=T[k],e=i+1<ORDER.length?T[ORDER[i+1]]:T.total;const el=$("sc-"+k);
    if(t>=s&&t<e){el.style.display="block";const lt=t-s;
      const fo=Math.min(1,pr(lt,0,.35)+0)*(1-pr(t,e-.3,e));
      el.style.opacity=fo;F[k](lt);
      if(DOTS[k]){dotOp=fo;dotIdx=DOTS[k]}
    }else el.style.display="none";
  });
  const d=$("dots");d.style.opacity=dotOp;for(let i=1;i<=6;i++)$("dt"+i).className=i===dotIdx?"on":"";
};
render(0);
</script></html>`;
}
