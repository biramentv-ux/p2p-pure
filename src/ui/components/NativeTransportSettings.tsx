import { useState } from "react";
import { useI18n } from "../../i18n";
import { nativeBridge } from "../../native/bridge";
import { nativeTransportEnabled, setNativeTransportEnabled } from "../../native/nativeConnect";

/**
 * П4 (experiment): the native transport switch. Shown only in a native shell (Electron, Tauri
 * built with "native-transport", Android); a browser has no UDP sockets, so nothing to switch.
 */
export function NativeTransportSettings() {
  const { t } = useI18n();
  const [on, setOn] = useState(() => nativeTransportEnabled());
  if (!nativeBridge()) return null;
  return (
    <details className="turn-settings native-settings">
      <summary>{t("Експериментален нативен транспорт")}</summary>
      <label className="confirm-row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setNativeTransportEnabled(e.target.checked);
          }}
        />
        {t("Пробивай NAT със собствени UDP сокети, когато WebRTC не успее")}
      </label>
      <p role="note">
        {t(
          "Поканата носи и публичния адрес на устройството. При симетричен NAT приложението отваря до 256 сокета за няколко секунди. Може да поиска от рутера временно пренасочване на порт (UPnP, NAT-PMP, PCP). Съобщенията остават шифровани както винаги; разговорите през този път не работят.",
        )}
      </p>
    </details>
  );
}
