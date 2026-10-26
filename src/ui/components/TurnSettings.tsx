import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { UnlockedIdentity } from "../../identity";
import { deriveHistoryKey } from "../../history/messageStore";
import { useI18n } from "../../i18n";
import {
  DEFAULT_TURN_SETTINGS,
  setActiveTurn,
  validateTurnSettings,
  type TurnErrorCode,
  type TurnSettings as TurnSettingsValue,
  type TurnWarningCode,
} from "../../p2p/turnConfig";
import { clearTurnSettings, loadTurnSettings, saveTurnSettings } from "../../p2p/turnStore";

interface Props {
  identity: UnlockedIdentity;
}

/** Optional own TURN relay. Off by default; the app ships no server and no credentials. */
export function TurnSettings({ identity }: Props) {
  const { t } = useI18n();
  const historyKey = useMemo(() => deriveHistoryKey(identity), [identity]);
  const [form, setForm] = useState<TurnSettingsValue>(DEFAULT_TURN_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<TurnWarningCode[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadTurnSettings(historyKey)
      .then((s) => alive && s && setForm(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [historyKey]);

  function errorText(code: TurnErrorCode): string {
    switch (code) {
      case "URL_EMPTY":
        return t("Въведи адрес на TURN сървър.");
      case "URL_SCHEME":
        return t("Адресът трябва да започва с turn: или turns:.");
      case "URL_EMBEDDED_CREDENTIALS":
        return t("Не слагай потребител и парола в адреса. Въведи ги в отделните полета.");
      case "URL_HOST":
        return t("Невалидно име на сървър.");
      case "URL_PORT":
        return t("Невалиден порт (1 до 65535).");
      case "URL_QUERY":
        return t("Позволено е само ?transport=udp или ?transport=tcp.");
      case "URL_TOO_LONG":
        return t("Адресът е твърде дълъг.");
      case "USERNAME_EMPTY":
        return t("Въведи потребителско име.");
      case "CREDENTIAL_EMPTY":
        return t("Въведи парола за релея.");
      case "FIELD_TOO_LONG":
        return t("Полето е твърде дълго.");
      case "FIELD_CONTROL_CHARS":
        return t("Полето съдържа непозволени знаци.");
      default:
        return t("Невалиден адрес. Формат: turn:хост:порт или turns:хост:порт.");
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    const checked = validateTurnSettings(form);
    if (!checked.ok) {
      setError(errorText(checked.error));
      setWarnings([]);
      return;
    }
    setError(null);
    setWarnings(checked.warnings);
    try {
      await saveTurnSettings(historyKey, checked.settings);
      setActiveTurn(checked.settings);
      setForm(checked.settings);
      setStatus(
        checked.settings.enabled
          ? t("Запазено. Новите връзки ще минават през твоя релей, ако директна връзка не е възможна.")
          : t("Запазено, но релеят е изключен."),
      );
    } catch {
      setError(t("Не успяхме да запазим настройките."));
    }
  }

  async function onRemove() {
    await clearTurnSettings().catch(() => undefined);
    setForm(DEFAULT_TURN_SETTINGS);
    setWarnings([]);
    setError(null);
    setStatus(t("Релеят и данните му са изтрити."));
  }

  return (
    <details className="turn-settings">
      <summary>{t("Настройки: собствен TURN релей (по избор)")}</summary>
      <form onSubmit={(e) => void onSave(e)}>
        <p role="note">
          {t(
            "Изключен по подразбиране. Приложението не включва никакъв TURN сървър. Релеят вижда метаданни за трафика (IP адреси, време и размер на пакетите), но не и съдържанието: всичко е криптирано от край до край.",
          )}
        </p>
        <label className="confirm-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          {t("Използвай мой TURN релей, когато директната връзка не успее")}
        </label>
        <label>
          {t("Адрес (turn: или turns:)")}
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="turns:turn.example.org:5349"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
        </label>
        <label>
          {t("Потребителско име")}
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>
        <label>
          {t("Парола на релея")}
          <input
            type="password"
            autoComplete="off"
            value={form.credential}
            onChange={(e) => setForm({ ...form, credential: e.target.value })}
          />
        </label>
        <label className="confirm-row">
          <input
            type="checkbox"
            checked={form.relayOnly}
            onChange={(e) => setForm({ ...form, relayOnly: e.target.checked })}
          />
          {t("Само през релей (скрива IP адреса ти от другия човек)")}
        </label>
        <p>
          {t(
            "Паролата се пази само криптирана на това устройство и е достъпна само докато е отключено. Само през релей означава и по-бавна връзка, и че релеят вижда всичките ти връзки.",
          )}
        </p>
        {warnings.includes("PRIVATE_HOST") && (
          <p role="alert">
            {t("Внимание: адресът е от частна или локална мрежа. Другият човек вероятно няма да може да стигне до него.")}
          </p>
        )}
        {warnings.includes("PLAIN_TURN") && (
          <p role="alert">
            {t("Внимание: turn: не е обвит в TLS, затова мрежата вижда, че ползваш релей. Предпочети turns:. Съдържанието остава криптирано.")}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {status && <p role="status">{status}</p>}
        <button type="submit">{t("Запази")}</button>
        <button type="button" className="secondary" onClick={() => void onRemove()}>
          {t("Изтрий релея")}
        </button>
      </form>
    </details>
  );
}
