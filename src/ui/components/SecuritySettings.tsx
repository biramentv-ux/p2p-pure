import { useState } from "react";
import { useI18n } from "../../i18n";
import { LOCK_EVENT, LOCK_MINUTES, loadLockSettings, saveLockSettings, type LockSettings } from "../lockSettings";

/** When the app locks itself (Н7). Per device. */
export function SecuritySettings({ onPanic }: { onPanic: () => Promise<void> }) {
  const { t } = useI18n();
  const [form, setForm] = useState<LockSettings>(() => loadLockSettings());

  function update(next: LockSettings) {
    setForm(next);
    saveLockSettings(next);
    window.dispatchEvent(new Event(LOCK_EVENT));
  }

  return (
    <details className="turn-settings security-settings">
      <summary>{t("Защита на устройството")}</summary>
      <label>
        {t("Заключвай след неактивност")}{" "}
        <select value={form.minutes} onChange={(e) => update({ ...form, minutes: Number(e.target.value) as LockSettings["minutes"] })}>
          {LOCK_MINUTES.map((m) => (
            <option key={m} value={m}>
              {t("{n} мин", { n: m })}
            </option>
          ))}
        </select>
      </label>
      <label className="confirm-row">
        <input type="checkbox" checked={form.onHide} onChange={(e) => update({ ...form, onHide: e.target.checked })} />
        {t("Заключвай и когато приложението е във фона повече от 30 секунди")}
      </label>
      <p role="note">
        {t("Изчезващите съобщения се включват за всеки чат поотделно: в чата, бутон „Криптография“.")}
      </p>
      <PanicWipe onPanic={onPanic} />
    </details>
  );
}

/**
 * "Delete everything now": one confirmation, then this device holds nothing of the identity,
 * the contacts, the history or the files. Shown in the settings and on the unlock screen.
 */
export function PanicWipe({ onPanic }: { onPanic: () => Promise<void> }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await onPanic();
    } catch {
      setError(t("Изтриването не успя. Опитай отново."));
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <button type="button" className="danger panic-button" onClick={() => setAsking(true)}>
        {t("Изтрий всичко от това устройство")}
      </button>
    );
  }
  return (
    <section className="call-panel panic-confirm" role="alertdialog" aria-label={t("Потвърди изтриването")}>
      <p>
        {t(
          "Самоличността, контактите, историята и файловете ще изчезнат от това устройство веднага. Само 12-те думи могат да върнат самоличността; историята не се връща.",
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="call-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => void run()}>
          {busy ? t("Изтривам…") : t("Да, изтрий всичко")}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(false)}>
          {t("Не")}
        </button>
      </div>
    </section>
  );
}
