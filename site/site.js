import { EN, BG_EXTRA } from "./i18n.js";
import { DEFAULT_LOCALE, localeOf } from "./locales.js";
import { RELEASES_URL, detectOS, formatSize } from "./downloads.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* optional */ } },
};

/* ------------------------------------------------------------------ language */
// Each language is its own page, written at build time (scripts/site/build.mjs): "/" Bulgarian,
// "/en/", "/es/" … (site/locales.js). The page already carries its texts; read them once so the
// download button can go back to its own words. Only the texts made while the page runs (button
// labels, the demo, "copied") come from the language's pack, loaded for this page alone.
const own = new Map();
for (const el of $$("[data-i18n]")) own.set(el, el.textContent);
const lang = localeOf(root.dataset.lang) ? root.dataset.lang : DEFAULT_LOCALE;
const pack = lang === "bg" ? BG_EXTRA : lang === "en" ? EN : (await import(`./i18n/${lang}.js`)).default;
let releases = {};

const t = (key) => pack[key] ?? EN[key] ?? "";

function applyLang() {
  fillDownloads();
  restartDemo();
  markMarquee();
  placeInk();
}

const langMenu = $("[data-langs-menu]");
for (const a of $$("[data-lang-list] a")) {
  // remembered, so the next visit opens in this language (boot.js); the link itself does the switch
  a.addEventListener("click", () => store.set("site-lang", a.dataset.code || a.getAttribute("hreflang")));
}
if (langMenu) {
  document.addEventListener("click", (e) => { if (langMenu.open && !langMenu.contains(e.target)) langMenu.open = false; });
  langMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && langMenu.open) { langMenu.open = false; $("summary", langMenu).focus(); }
  });
}

/* ------------------------------------------------------------------ theme */
$("[data-theme-toggle]").addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
  root.setAttribute("data-theme", next);
  store.set("site-theme", next);
});

/* ------------------------------------------------------------------ menu */
const menu = $("#menu");
const burger = $("[data-menu-toggle]");
let menuTimer = 0;
function setMenu(open) {
  clearTimeout(menuTimer);
  burger.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("menu-open", open);
  if (open) {
    menu.hidden = false;
    void menu.offsetWidth; // let the closed state paint, so the reveal can animate
    menu.classList.add("open");
    $("a", menu)?.focus({ preventScroll: true });
  } else {
    menu.classList.remove("open");
    menuTimer = setTimeout(() => { menu.hidden = true; }, reduced ? 0 : 720);
  }
}
burger.addEventListener("click", () => setMenu(burger.getAttribute("aria-expanded") !== "true"));
menu.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && burger.getAttribute("aria-expanded") === "true") { setMenu(false); burger.focus(); }
});
matchMedia("(min-width: 1081px)").addEventListener("change", (e) => { if (e.matches) setMenu(false); });

/* ------------------------------------------------------------------ bar, progress, active link */
const bar = $(".bar");
const progress = $(".progress span");
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.setProperty("--p", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : "0");
    bar.classList.toggle("scrolled", scrollY > 8);
    ticking = false;
  });
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

const navLinks = $$(".nav a");
const sections = navLinks.map((a) => $(a.getAttribute("href"))).filter(Boolean);
const spy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    for (const a of navLinks) a.classList.toggle("active", a.getAttribute("href") === `#${en.target.id}`);
  }
}, { rootMargin: "-45% 0px -50% 0px" });
sections.forEach((s) => spy.observe(s));

/* ------------------------------------------------------------------ palette travels with the scroll */
// [hue of the cool accent, hue of the warm accent] in OKLCH; the root eases between them (see @property).
const PALETTES = [[222, 350], [200, 320], [255, 8], [165, 300], [285, 45], [222, 350], [330, 200], [10, 250], [195, 335]];
const paletteObserver = new IntersectionObserver((entries) => {
  const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!best) return;
  const p = PALETTES[Number(best.target.dataset.palette)] || PALETTES[0];
  root.style.setProperty("--ha", String(p[0]));
  root.style.setProperty("--hb", String(p[1]));
}, { threshold: [0.25, 0.5, 0.75], rootMargin: "-20% 0px -20% 0px" });
$$("[data-palette]").forEach((s) => paletteObserver.observe(s));

/* ------------------------------------------------------------------ reveal + counters */
function stagger(el) {
  const sibs = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c.classList.contains("reveal")) : [];
  const i = Math.max(0, sibs.indexOf(el));
  el.style.setProperty("--d", `${Math.min(i, 8) * 0.08}s`);
}
function countUp(el) {
  const target = Number(el.dataset.count);
  const suffix = el.dataset.suffix || "";
  if (reduced || !Number.isFinite(target) || target === 0) { el.textContent = `${target}${suffix}`; return; }
  const start = performance.now();
  const dur = 1400;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - k, 4);
    el.textContent = `${Math.round(target * eased)}${suffix}`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const reveal = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    en.target.classList.add("in");
    const c = $("[data-count]", en.target);
    if (c) countUp(c);
    reveal.unobserve(en.target);
  }
}, { threshold: 0.14, rootMargin: "0px 0px -6% 0px" });
$$(".reveal").forEach((el) => { stagger(el); reveal.observe(el); });
const stepsList = $(".steps");
if (stepsList) new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { stepsList.classList.add("in"); o.disconnect(); } }, { threshold: 0.3 }).observe(stepsList);

/* ------------------------------------------------------------------ six ways: a scene plays only while its card is on screen */
const wayObserver = new IntersectionObserver((entries) => {
  for (const en of entries) en.target.classList.toggle("live", en.isIntersecting);
}, { threshold: 0.2 });
$$(".way").forEach((c) => wayObserver.observe(c));

/* ------------------------------------------------------------------ tilt cards and magnetic buttons */
if (finePointer && !reduced) {
  for (const card of $$("[data-tilt]")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      card.style.setProperty("--mx", `${x}px`);
      card.style.setProperty("--my", `${y}px`);
      card.style.setProperty("--ry", `${((x / r.width) - 0.5) * 6}deg`);
      card.style.setProperty("--rx", `${((y / r.height) - 0.5) * -6}deg`);
    });
    card.addEventListener("pointerleave", () => { card.style.setProperty("--rx", "0deg"); card.style.setProperty("--ry", "0deg"); });
  }
  for (const b of $$(".magnet")) {
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      b.style.translate = `${((e.clientX - r.left) / r.width - 0.5) * 10}px ${((e.clientY - r.top) / r.height - 0.5) * 8}px`;
    });
    b.addEventListener("pointerleave", () => { b.style.translate = ""; });
  }
}

/* ------------------------------------------------------------------ marquee: twice the words, so -50% loops */
function markMarquee() {
  const track = $("[data-marquee]");
  if (!track || reduced) return;
  // the language switch rewrites the track, so build the second half again each time
  if (!track.dataset.single) track.dataset.single = String(track.children.length);
  while (track.children.length > Number(track.dataset.single)) track.lastChild.remove();
  const first = Array.from(track.children);
  for (const n of first) { const c = n.cloneNode(true); c.setAttribute("aria-hidden", "true"); track.append(c); }
}

/* ------------------------------------------------------------------ the demo: seal, travel, open */
const GLYPHS = "░▒▓#%&@$01ABCDEF<>/\\|+=*";
const demo = {
  out: $("[data-demo-out]"), cipher: $("[data-demo-cipher]"), inn: $("[data-demo-in]"),
  packet: $("[data-demo-packet]"), path: $("#wirepath"), wire: $(".wire"), root: $(".demo"),
};
let demoRun = 0;
let demoVisible = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scramble = (n) => Array.from({ length: n }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join("");

function msgs() { return t("demoMsgs"); }

async function typeInto(el, text, run) {
  el.textContent = "";
  for (const ch of text) {
    if (run !== demoRun) return false;
    el.textContent += ch;
    await sleep(34);
  }
  return true;
}
async function decryptInto(el, text, run) {
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    if (run !== demoRun) return false;
    const keep = Math.floor((text.length * i) / steps);
    el.textContent = text.slice(0, keep) + scramble(Math.max(0, Math.min(text.length - keep, 10)));
    await sleep(46);
  }
  el.textContent = text;
  return true;
}
function moveAlong(run) {
  return new Promise((resolve) => {
    const len = demo.path.getTotalLength();
    const w = demo.wire.clientWidth / 200;
    const t0 = performance.now();
    const dur = 1300;
    demo.packet.style.opacity = "1";
    const frame = (now) => {
      if (run !== demoRun) return resolve(false);
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p = demo.path.getPointAtLength(len * e);
      demo.packet.style.transform = `translate(${p.x * w}px, ${30 + p.y}px)`;
      if (k < 1) requestAnimationFrame(frame); else { demo.packet.style.opacity = "0"; resolve(true); }
    };
    requestAnimationFrame(frame);
  });
}
function showStatic() {
  const m = msgs()[0];
  demo.out.textContent = m;
  demo.inn.textContent = m;
  demo.cipher.textContent = "9f3a·c1e0·7b52·a8d4";
}
async function demoLoop(run) {
  let i = 0;
  while (run === demoRun) {
    if (!demoVisible) { await sleep(400); continue; }
    const m = msgs()[i++ % msgs().length];
    demo.inn.textContent = "";
    if (!(await typeInto(demo.out, m, run))) return;
    await sleep(280);
    for (let k = 0; k < 7 && run === demoRun; k++) { demo.cipher.textContent = scramble(Math.min(44, m.length + 8)); await sleep(70); }
    if (!(await moveAlong(run))) return;
    if (!(await decryptInto(demo.inn, m, run))) return;
    demo.cipher.textContent = "";
    await sleep(2600);
  }
}
function restartDemo() {
  demoRun++;
  if (!demo.root) return;
  if (reduced) { showStatic(); return; }
  demoLoop(demoRun);
}
if (demo.root) new IntersectionObserver((es) => { demoVisible = es[0].isIntersecting; }, { threshold: 0.2 }).observe(demo.root);

/* ------------------------------------------------------------------ downloads */
const OS_TAB = { windows: "windows", linux: "linux", android: "android", ios: "ios", mac: "web", other: "web" };
const os = detectOS(navigator.userAgent, navigator.platform || "", navigator.maxTouchPoints || 0);
try { releases = JSON.parse($("#releases").textContent || "{}") || {}; } catch { releases = {}; }

function badgeFor(el, kinds) {
  const hit = kinds.map((k) => releases[k]).find(Boolean);
  el.className = "badge";
  if (!hit) { el.textContent = t("badgeSoon"); el.classList.add("soft"); return; }
  el.textContent = hit.preview ? `${t("badgePreview")} · v${hit.version}` : `v${hit.version}`;
  if (hit.preview) el.classList.add("preview");
}

function fillDownloads() {
  for (const a of $$("a.file[data-kind]")) {
    const hit = releases[a.dataset.kind];
    const meta = $(".meta", a);
    a.classList.toggle("missing", !hit);
    if (hit) {
      a.href = hit.url;
      a.removeAttribute("target");
      a.setAttribute("rel", "noopener");
      meta.textContent = [formatSize(hit.size), hit.name].filter(Boolean).join(" · ");
    } else {
      a.href = RELEASES_URL;
      a.setAttribute("rel", "noopener");
      meta.textContent = t("soon");
    }
  }
  badgeFor($('[data-badge="windows"]'), ["windowsSetup", "windowsPortable"]);
  badgeFor($('[data-badge="linux"]'), ["deb", "appimage", "rpm", "flatpak"]);
  badgeFor($('[data-badge="android"]'), ["apk"]);

  const install = releases.linuxInstall;
  const line = $("[data-install-line]");
  if (install && line) {
    $("[data-install-cmd]", line).textContent = `curl -fsSLO ${install.url} && less install.sh && bash install.sh`;
    line.hidden = false;
  }
  setPrimary();
  $$(".os-tabs .rec").forEach((n) => n.remove());
  const tab = $(`[data-tab="${OS_TAB[os]}"]`);
  if (tab && OS_TAB[os] !== "web") { const dot = document.createElement("i"); dot.className = "rec"; dot.setAttribute("aria-hidden", "true"); tab.append(dot); }
}

function setPrimary() {
  const name = t("osNames")[os] || "";
  const direct = { windows: "windowsSetup", linux: "deb", android: "apk" }[os];
  const hit = direct && releases[direct];
  for (const a of $$("[data-primary-download]")) {
    const label = $("[data-primary-label]", a);
    if (hit) {
      a.href = hit.url;
      label.textContent = t("ctaFor").replace("{os}", name);
    } else if (os === "ios") {
      a.href = "app/";
      label.textContent = t("ctaOpenFor").replace("{os}", name);
    } else if (os === "mac") {
      a.href = "app/";
      label.textContent = t("ctaWebFor");
    } else {
      a.href = "#download";
      label.textContent = own.get(label) ?? label.textContent;
    }
    a.dataset.os = os;
  }
  const note = $("[data-primary-note]");
  if (note && hit) {
    note.textContent = `${hit.name} · ${formatSize(hit.size)}${hit.preview ? ` · ${t("badgePreview")}` : ""}`;
  } else if (note) {
    note.textContent = own.get(note) ?? note.textContent;
  }
}

/* the Chrome extension: version, size and SHA-256 come from the build (downloads/extension.json) */
function fillExtension() {
  let info = {};
  try { info = JSON.parse($("#extension-info")?.textContent || "{}") || {}; } catch { info = {}; }
  const badge = $("[data-ext-badge]");
  if (!info.version || !info.sha256) return; // the link still works; only the details are missing
  badge.textContent = `v${info.version}`;
  $("[data-ext-meta]").textContent = [formatSize(info.size), info.file].filter(Boolean).join(" · ");
  $("[data-ext-sha]").textContent = info.sha256;
  $("[data-ext-sha-line]").hidden = false;
}
fillExtension();

/* tabs */
const tabs = $$(".os-tabs [role=tab]");
const ink = $(".tab-ink");
function placeInk() {
  const cur = tabs.find((x) => x.getAttribute("aria-selected") === "true");
  if (!cur || !ink) return;
  ink.style.width = `${cur.offsetWidth}px`;
  ink.style.transform = `translateX(${cur.offsetLeft}px)`;
}
function selectTab(name, focus = false) {
  for (const tb of tabs) {
    const on = tb.dataset.tab === name;
    tb.setAttribute("aria-selected", String(on));
    tb.tabIndex = on ? 0 : -1;
    const panel = $(`[data-panel="${tb.dataset.tab}"]`);
    if (panel) panel.hidden = !on;
    if (on && focus) tb.focus();
  }
  placeInk();
}
tabs.forEach((tb) => tb.addEventListener("click", () => selectTab(tb.dataset.tab)));
$(".os-tabs")?.addEventListener("keydown", (e) => {
  const i = tabs.findIndex((x) => x.getAttribute("aria-selected") === "true");
  const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  selectTab(tabs[(next + tabs.length) % tabs.length].dataset.tab, true);
});
function tabFromHash() {
  const m = /^#dl-(windows|linux|android|ios|web|extension)$/.exec(location.hash);
  if (m) selectTab(m[1]);
  return Boolean(m);
}
// links that open a tab of the downloads section (the Chrome extension link in the hero)
for (const a of $$("[data-open-tab]")) a.addEventListener("click", () => selectTab(a.dataset.openTab));
addEventListener("hashchange", tabFromHash);
addEventListener("resize", placeInk);
document.fonts?.ready.then(placeInk);

/* copy buttons */
for (const b of $$(".copy")) {
  b.addEventListener("click", async () => {
    const text = b.dataset.copy ?? $(b.dataset.copyFrom)?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.append(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* the text is visible and can be selected by hand */ }
      ta.remove();
    }
    const old = b.textContent;
    b.textContent = t("copied");
    b.classList.add("done");
    setTimeout(() => { b.textContent = old; b.classList.remove("done"); }, 1800);
  });
}

/* ------------------------------------------------------------------ start */
selectTab(OS_TAB[os] || "windows");
if (tabFromHash()) requestAnimationFrame(() => $(location.hash)?.scrollIntoView());
applyLang();
