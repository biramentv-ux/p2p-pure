import { LANGS, LANG_NAMES, useI18n, type Lang } from "../../i18n";

/**
 * Language picker. A native <select>: six languages do not fit as buttons in the chat header,
 * and the system list is keyboard and screen-reader friendly everywhere. The closed control shows
 * a short code; each option shows the language's own name, so it stays readable whatever is active.
 */
const SHORT: Record<Lang, string> = { bg: "БГ", en: "EN", ru: "RU", de: "DE", es: "ES", pt: "PT" };

export function LanguageSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <label className="lang-switch">
      <span className="visually-hidden">{t("Език")}</span>
      <span className="lang-code" aria-hidden="true">
        {SHORT[lang]}
      </span>
      <select
        className="lang-select"
        value={lang}
        lang={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
      >
        {LANGS.map((code) => (
          <option key={code} value={code} lang={code}>
            {LANG_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
