/*
 * Language layer (pure logic, no React). The Bulgarian text is the source: every call is t("Български текст").
 * A missing English entry falls back to the Bulgarian text, so a gap never shows
 * an empty label. Placeholders use {name} and are filled from the vars object.
 *
 * Only the UI calls t(). Services keep their messages in Bulgarian, so the unit
 * tests that assert on them do not depend on the language setting.
 */
import { EN_DICTIONARY } from "./en";
import { RU_DICTIONARY } from "./ru";
import { DE_DICTIONARY } from "./de";
import { ES_DICTIONARY } from "./es";
import { PT_DICTIONARY } from "./pt";

export type Lang = "bg" | "en" | "ru" | "de" | "es" | "pt";
export const LANGS: readonly Lang[] = ["bg", "en", "ru", "de", "es", "pt"];

/** Native names, never translated: a person must recognise their own language. */
export const LANG_NAMES: Record<Lang, string> = {
  bg: "Български",
  en: "English",
  ru: "Русский",
  de: "Deutsch",
  es: "Español",
  pt: "Português",
};

/** Every language except Bulgarian (the source) has a dictionary keyed by the Bulgarian text. */
const DICTIONARIES: Record<Exclude<Lang, "bg">, Record<string, string>> = {
  en: EN_DICTIONARY,
  ru: RU_DICTIONARY,
  de: DE_DICTIONARY,
  es: ES_DICTIONARY,
  pt: PT_DICTIONARY,
};

const STORAGE_KEY = "p2p.lang";

export type Vars = Record<string, string | number>;

/** Pure translation. Exported for tests and for code that runs outside React. */
export function translate(lang: Lang, source: string, vars?: Vars): string {
  // A gap in a newer language shows English, never an empty label; English falls back to Bulgarian.
  const template = lang === "bg" ? source : (DICTIONARIES[lang][source] ?? EN_DICTIONARY[source] ?? source);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/** Saved choice first, then the browser language; English when the browser language is not offered. */
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
  const prefix = browserLanguage?.toLowerCase().split(/[-_]/)[0];
  return isLang(prefix) ? prefix : "en";
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

const LOCALES: Record<Lang, string> = { bg: "bg-BG", en: "en-GB", ru: "ru-RU", de: "de-DE", es: "es-ES", pt: "pt-BR" };

export function localeFor(lang: Lang): string {
  return LOCALES[lang];
}

export interface I18n {
  lang: Lang;
  locale: string;
  setLang: (lang: Lang) => void;
  t: (source: string, vars?: Vars) => string;
}
