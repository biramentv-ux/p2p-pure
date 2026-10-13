import { QrCode } from "../components/QrCode";
import type { UnlockedIdentity } from "../../identity";

interface ShowQrScreenProps {
  identity: UnlockedIdentity;
}

export function ShowQrScreen({ identity }: ShowQrScreenProps) {
  return (
    <div className="screen">
      <h1>Твоята идентичност</h1>
      <p>Покажи този QR код на контакт, за да установите връзка.</p>
      <QrCode data={identity.did} size={300} label="Идентификационен QR код" />
      <p className="did-text" title={identity.did}>
        {identity.did}
      </p>
    </div>
  );
}
