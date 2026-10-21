import { useEffect, useMemo, useState, type ReactNode } from "react";
import { detectLang, localeFor, saveLang, translate, type I18n, type Lang } from "./core";
import { I18nContext } from "./context";

/** Holds the active language for the whole app and keeps <html lang> in step with it. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang());

  const value = useMemo<I18n>(
    () => ({
      lang,
      locale: localeFor(lang),
      setLang: (next: Lang) => {
        saveLang(next);
        setLangState(next);
      },
      t: (source, vars) => translate(lang, source, vars),
    }),
    [lang],
  );

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
