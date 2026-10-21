import { useContext } from "react";
import { detectLang, localeFor, saveLang, translate, type I18n } from "./core";
import { I18nContext } from "./context";

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  // Rendering outside the provider (isolated tests only) uses the detected language.
  const lang = detectLang();
  return { lang, locale: localeFor(lang), setLang: saveLang, t: (s, v) => translate(lang, s, v) };
}
