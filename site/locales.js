/**
 * The one list of the landing page's languages. The build (scripts/site/build.mjs), the page script
 * (site.js), the tests and the language menu all read it; nothing else lists the codes.
 *
 *   code     the page's key, its folder ("" for Bulgarian, the default) and the site-lang value
 *   html     <html lang> and hreflang (BCP 47)
 *   og       og:locale
 *   name     the language's name in itself, shown in the menu
 *   short    the two letters on the menu button
 *   image    the share picture (only Bulgarian and English have their own)
 *   scripts  what most letters of a translation must be written in (checked by the tests)
 */
export const LOCALES = [
  { code: "bg", path: "", html: "bg", og: "bg_BG", name: "Български", short: "БГ", image: "og-bg.png", scripts: ["Cyrillic"] },
  { code: "en", path: "en/", html: "en", og: "en_US", name: "English", short: "EN", image: "og-en.png", scripts: ["Latin"] },
  { code: "es", path: "es/", html: "es", og: "es_ES", name: "Español", short: "ES", image: "og-en.png", scripts: ["Latin"] },
  { code: "pt", path: "pt/", html: "pt-BR", og: "pt_BR", name: "Português (Brasil)", short: "PT", image: "og-en.png", scripts: ["Latin"] },
  { code: "fr", path: "fr/", html: "fr", og: "fr_FR", name: "Français", short: "FR", image: "og-en.png", scripts: ["Latin"] },
  { code: "de", path: "de/", html: "de", og: "de_DE", name: "Deutsch", short: "DE", image: "og-en.png", scripts: ["Latin"] },
  { code: "ru", path: "ru/", html: "ru", og: "ru_RU", name: "Русский", short: "RU", image: "og-en.png", scripts: ["Cyrillic"] },
  { code: "zh", path: "zh/", html: "zh-Hans", og: "zh_CN", name: "简体中文", short: "中文", image: "og-en.png", scripts: ["Han"] },
];

export const DEFAULT_LOCALE = "bg";

/** The keys whose text changes when the source code is private (see CLOSED_TEXT in the build). */
export const CLOSED_KEYS = ["ctaNote", "sec1t", "sec1p", "a5", "a6", "marquee"];

export const localeOf = (code) => LOCALES.find((l) => l.code === code);
