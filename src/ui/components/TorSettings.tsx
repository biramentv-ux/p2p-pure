import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { torBridge } from "../../tor/torBridge";
import { setTorOnlyEnabled, torOnlyEnabled } from "../../tor/torPairing";

/**
 * П6 (experiment): onion-only mode. Shown only in a build that has Tor: Tauri with the
 * "tor-transport" feature, or an Android APK that carries libp2ptor.so; elsewhere there is nothing to switch.
 */
export function TorSettings() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(() => torOnlyEnabled());
  useEffect(() => {
    let alive = true;
    void torBridge().then((b) => alive && setAvailable(b !== null));
    return () => {
      alive = false;
    };
  }, []);
  if (!available) return null;
  return (
    <details className="turn-settings tor-settings">
      <summary>{t("Само през Tor (експеримент)")}</summary>
      <label className="confirm-row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setTorOnlyEnabled(e.target.checked);
          }}
        />
        {t("Свързвай се само през onion услуги, без да показваш IP адреса си")}
      </label>
      <p role="note">
        {t(
          "Поканата съдържа onion адрес вместо IP адреси. Двамата трябва да са включили режима. Свързването е по-бавно (до няколко минути), разговорите не работят. Откриването през интернет (Nostr) показва IP адреса на релетата: в този режим не го ползвай.",
        )}
      </p>
    </details>
  );
}
