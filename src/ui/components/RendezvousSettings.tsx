import { useState } from "react";
import { useI18n } from "../../i18n";
import { configuredRelays, rendezvousEnabled, setRendezvousEnabled } from "../../rendezvous/settings";

/**
 * Н2: finding known contacts again over the internet through public Nostr relays. Off by
 * default, with the trade-off said plainly (docs/THREAT_MODEL.md).
 */
export function RendezvousSettings() {
  const { t } = useI18n();
  const [on, setOn] = useState(() => rendezvousEnabled());
  return (
    <details className="turn-settings rv-settings">
      <summary>{t("Откриване през интернет")}</summary>
      <label className="confirm-row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setRendezvousEnabled(e.target.checked);
          }}
        />
        {t("Намирай познатите ми контакти без нов QR (през публични Nostr релета)")}
      </label>
      <p role="note">
        {t(
          "Релетата пренасят само шифрован текст под тема, която се сменя на всеки 15 минути: не виждат кой с кого говори, нито поканата. Виждат обаче IP адреса на устройството и кога публикува. Работи само докато приложението е отворено и отключено и при двамата.",
        )}
      </p>
      <p>
        <small>{t("Релета: {list}", { list: configuredRelays().map((u) => u.replace(/^wss?:\/\//, "")).join(", ") })}</small>
      </p>
    </details>
  );
}
