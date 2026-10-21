import { LANGS, LANG_NAMES, useI18n } from "../../i18n";

/**
 * Two-way language switch. Each option shows the language's own name, so it stays
 * readable no matter which language is active. Visible on every screen.
 */
export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t("Език")}>
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          className={code === lang ? "lang-option active" : "lang-option"}
          aria-pressed={code === lang}
          onClick={() => setLang(code)}
        >
          {code === "bg" ? "БГ" : "EN"}
          <span className="visually-hidden">{LANG_NAMES[code]}</span>
        </button>
      ))}
    </div>
  );
}
