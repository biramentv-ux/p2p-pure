/*
 * Language layer (pure logic, no React). The Bulgarian text is the source: every call is t("Български текст").
 * A missing English entry falls back to the Bulgarian text, so a gap never shows
 * an empty label. Placeholders use {name} and are filled from the vars object.
 *
 * Only the UI calls t(). Services keep their messages in Bulgarian, so the unit
 * tests that assert on them do not depend on the language setting.
 */
import { EN_DICTIONARY } from "./en";

export type Lang = "bg" | "en";
export const LANGS: readonly Lang[] = ["bg", "en"];

/** Native names, never translated: a person must recognise their own language. */
export const LANG_NAMES: Record<Lang, string> = { bg: "Български", en: "English" };

const STORAGE_KEY = "p2p.lang";

export type Vars = Record<string, string | number>;

/** Pure translation. Exported for tests and for code that runs outside React. */
export function translate(lang: Lang, source: string, vars?: Vars): string {
  const template = lang === "en" ? (EN_DICTIONARY[source] ?? source) : source;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

function isLang(value: unknown): value is Lang {
  return value === "bg" || value === "en";
}

/** Saved choice first, then the browser language (Bulgarian stays the default for bg). */
export function detectLang(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
  browserLanguage: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language,
): Lang {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    // Storage can be blocked (private mode, site data cleared). Fall through.
  }
  return browserLanguage?.toLowerCase().startsWith("bg") ? "bg" : "en";
}

export function saveLang(lang: Lang): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, lang);
  } catch {
    // Not saved: the choice still applies for this visit.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function localeFor(lang: Lang): string {
  return lang === "bg" ? "bg-BG" : "en-GB";
}

export interface I18n {
  lang: Lang;
  locale: string;
  setLang: (lang: Lang) => void;
  t: (source: string, vars?: Vars) => string;
}
