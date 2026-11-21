import { QrCode } from "../components/QrCode";
import type { UnlockedIdentity } from "../../identity";
import { useI18n } from "../../i18n";
import { TurnSettings } from "../components/TurnSettings";
import { NotificationSettings } from "../components/NotificationSettings";
import { SecuritySettings } from "../components/SecuritySettings";
import { RendezvousSettings } from "../components/RendezvousSettings";
import { NativeTransportSettings } from "../components/NativeTransportSettings";
import { TorSettings } from "../components/TorSettings";

interface ShowQrScreenProps {
  identity: UnlockedIdentity;
  /** Opens the one-time move of the identity to a new device. */
  onMove?: () => void;
  /** Panic wipe of this device (Н7). */
  onPanic?: () => Promise<void>;
}

export function ShowQrScreen({ identity, onMove, onPanic }: ShowQrScreenProps) {
  const { t } = useI18n();
  return (
    <div className="screen">
      <h1>{t("Твоята идентичност")}</h1>
      <p>{t("Покажи този QR код на контакт, за да установите връзка.")}</p>
      <QrCode data={identity.did} size={300} label={t("Идентификационен QR код")} />
      <p className="did-text" title={identity.did}>
        {identity.did}
      </p>
      {onMove && (
        <button className="secondary" onClick={onMove}>
          {t("Премести на ново устройство")}
        </button>
      )}
      <NotificationSettings />
      <TurnSettings identity={identity} />
      <RendezvousSettings />
      <NativeTransportSettings />
      <TorSettings />
      {onPanic && <SecuritySettings onPanic={onPanic} />}
    </div>
  );
}
