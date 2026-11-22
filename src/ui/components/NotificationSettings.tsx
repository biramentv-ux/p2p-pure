import { useState } from "react";
import { useI18n } from "../../i18n";
import {
  askPermission,
  loadNotifySettings,
  permission,
  saveNotifySettings,
  type NotifySettings,
} from "../../notify/notifier";
import { SOUNDS, playSound, primeAudio, type SoundId } from "../../notify/sounds";
import {
  backgroundLinkEnabled,
  backgroundLinkTexts,
  backgroundLinkPlugin,
  openBatterySettings,
  setBackgroundLinkEnabled,
  syncBackgroundLink,
} from "../../platform/mobile/backgroundLink";

/** Sounds and notifications for new messages from contacts and groups. Per device. */
export function NotificationSettings() {
  const { t } = useI18n();
  const [form, setForm] = useState<NotifySettings>(() => loadNotifySettings());
  const [perm, setPerm] = useState<string>(() => permission());
  const android = backgroundLinkPlugin() !== null;
  const [keepLink, setKeepLink] = useState(() => backgroundLinkEnabled());

  function update(next: NotifySettings) {
    setForm(next);
    saveNotifySettings(next);
  }

  function preview(id: SoundId) {
    primeAudio();
    playSound(id, form.volume);
  }

  async function allow() {
    primeAudio();
    setPerm(await askPermission());
  }

  return (
    <details className="turn-settings notify-settings">
      <summary>{t("Известия и звуци")}</summary>
      <p role="note">
        {t("Известие идва само докато приложението е отворено или е във фона. Няма сървър, който да го изпрати, когато е затворено.")}
      </p>
      {android && (
        <div className="keep-link">
          <label className="confirm-row">
            <input
              type="checkbox"
              checked={keepLink}
              onChange={(e) => {
                setKeepLink(e.target.checked);
                setBackgroundLinkEnabled(e.target.checked);
                void syncBackgroundLink(true, backgroundLinkTexts(t));
              }}
            />
            {t("Дръж връзките отворени и при изключен екран")}
          </label>
          <p className="hint">
            {t("Приложението остава будно с постоянно известие, така че съобщенията идват и при заключен телефон. Харчи батерия. Ако системата все пак го спира, изключи оптимизацията на батерията за него.")}
          </p>
          <button type="button" className="secondary" onClick={() => void openBatterySettings()}>
            {t("Настройки за батерията")}
          </button>
        </div>
      )}
      <label className="confirm-row">
        <input type="checkbox" checked={form.enabled} onChange={(e) => update({ ...form, enabled: e.target.checked })} />
        {t("Звук и известие при ново съобщение от контакт или група")}
      </label>

      {perm === "granted" && <p role="status">{t("Системните известия са разрешени.")}</p>}
      {perm === "denied" && (
        <p role="status">{t("Системните известия са забранени в браузъра. Разреши ги от настройките на сайта.")}</p>
      )}
      {perm === "unsupported" && <p role="status">{t("Това устройство не показва системни известия тук. Звукът работи.")}</p>}
      {perm === "default" && (
        <button type="button" className="secondary" disabled={!form.enabled} onClick={() => void allow()}>
          {t("Разреши известията на системата")}
        </button>
      )}

      <fieldset className="sound-list" disabled={!form.enabled}>
        <legend>{t("Звук")}</legend>
        {SOUNDS.map((s) => (
          <div className="sound-row" key={s.id}>
            <label className="confirm-row">
              <input
                type="radio"
                name="notify-sound"
                value={s.id}
                checked={form.sound === s.id}
                onChange={() => {
                  update({ ...form, sound: s.id });
                  preview(s.id);
                }}
              />
              {t(s.name)}
            </label>
            {s.id !== "none" && (
              <button type="button" className="secondary" aria-label={t("Пусни: {name}", { name: t(s.name) })} onClick={() => preview(s.id)}>
                ▶
              </button>
            )}
          </div>
        ))}
      </fieldset>

      <label>
        {t("Сила на звука")}
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={form.volume}
          disabled={!form.enabled || form.sound === "none"}
          onChange={(e) => update({ ...form, volume: Number(e.target.value) })}
          onPointerUp={() => preview(form.sound)}
          onKeyUp={() => preview(form.sound)}
        />
      </label>

      <label className="confirm-row">
        <input
          type="checkbox"
          checked={form.showText}
          disabled={!form.enabled}
          onChange={(e) => update({ ...form, showText: e.target.checked })}
        />
        {t("Показвай текста на съобщението в известието")}
      </label>
      <p>
        {t("Изключено: известието казва само кой ти пише. Системата пази известията извън шифроването на приложението.")}
      </p>
    </details>
  );
}
