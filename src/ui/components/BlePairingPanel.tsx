import { useEffect, useRef, useState } from "react";
import {
  BlePairingSession,
  isBleSupported,
  newBleTag,
  type BleDevice,
  type BleStatus,
} from "../../platform/mobile/blePairing";
import { useI18n } from "../../i18n";

interface BlePairingPanelProps {
  role: "initiator" | "responder";
  /** Initiator: the signed offer invitation to hand over. */
  offer?: string;
  /** Responder: turns the received offer into an answer invitation. */
  onOffer?: (invitation: string) => Promise<string>;
  /** Initiator: called with the received answer invitation. */
  onAnswer?: (invitation: string) => void;
  onCancel: () => void;
  /** Injectable for tests. */
  session?: BlePairingSession;
}

function signalKey(rssi: number): "strong" | "medium" | "weak" {
  if (rssi >= -60) return "strong";
  if (rssi >= -80) return "medium";
  return "weak";
}

/** Exchanges signed p2p1 invitations over Bluetooth Low Energy (native app only). */
export function BlePairingPanel({ role, offer, onOffer, onAnswer, onCancel, session }: BlePairingPanelProps) {
  const { t } = useI18n();
  const supported = isBleSupported();
  const [tag] = useState(() => newBleTag());
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [status, setStatus] = useState<BleStatus>({ phase: "starting" });
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState(false);

  const [ownSession] = useState(() => new BlePairingSession());
  const sess = session ?? ownSession;

  const cbs = useRef({ onOffer, onAnswer });
  useEffect(() => {
    cbs.current = { onOffer, onAnswer };
  }, [onOffer, onAnswer]);

  const ready = role === "responder" || offer !== undefined;

  useEffect(() => {
    if (!supported || !ready) return;
    const fail = (err: unknown) => {
      setError(err instanceof Error ? err.message : "Грешка при Bluetooth.");
    };
    if (role === "initiator") {
      sess
        .startAsInitiator({
          tag,
          offer: offer ?? "",
          onAnswer: (a) => cbs.current.onAnswer?.(a),
          onStatus: setStatus,
        })
        .catch(fail);
    } else {
      sess
        .startAsResponder({
          onDevices: setDevices,
          onOffer: async (o) => {
            if (!cbs.current.onOffer) throw new Error("Грешка при Bluetooth.");
            return cbs.current.onOffer(o);
          },
          onStatus: setStatus,
        })
        .catch(fail);
    }
    return () => sess.cancel();
  }, [supported, ready, role, offer, tag, sess, attempt]);

  if (!supported) {
    return <p className="net-hint">{t("Bluetooth работи само в приложението за Android и iOS.")}</p>;
  }

  function progressText(): string {
    switch (status.phase) {
      case "starting":
        return t("Стартирам Bluetooth…");
      case "waiting":
        return t("Чакам другия телефон…");
      case "scanning":
        return picked ? t("Свързвам се…") : t("Търся телефони наблизо…");
      case "connecting":
        return t("Свързвам се…");
      case "sending":
        return t("Изпращам: {done} от {total}", { done: (status.done ?? 0) + 1, total: status.total ?? 1 });
      case "receiving":
        return status.total
          ? t("Получавам: {done} от {total}", { done: status.done ?? 0, total: status.total })
          : t("Чакам данни…");
      case "processing":
        return t("Обработвам поканата…");
      case "done":
        return t("Готово.");
    }
  }

  const showProgress = !error && (status.phase === "sending" || (status.phase === "receiving" && !!status.total));

  function onRetry() {
    setError(null);
    setDevices([]);
    setPicked(false);
    setStatus({ phase: "starting" });
    setAttempt((n) => n + 1);
  }

  function onPick(d: BleDevice) {
    setPicked(true);
    void sess.pick(d.deviceId);
  }

  const signalLabel = (rssi: number) => {
    const k = signalKey(rssi);
    return k === "strong" ? t("силен сигнал") : k === "medium" ? t("среден сигнал") : t("слаб сигнал");
  };

  return (
    <div className="call-panel">
      {role === "initiator" ? (
        <>
          <p>{t("Покажи този код на другия телефон и избери го там.")}</p>
          <p className="short-code" aria-label={t("Код за Bluetooth")}>
            {tag}
          </p>
        </>
      ) : (
        !picked && (
          <>
            <p>{t("Избери кода, който се вижда на другия телефон.")}</p>
            {devices.length === 0 && !error && <p className="net-hint">{t("Още не е намерен телефон.")}</p>}
            {devices.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0 }}>
                {devices.map((d) => (
                  <li key={d.deviceId}>
                    <button className="secondary" onClick={() => onPick(d)}>
                      <strong className="short-code">{d.tag}</strong> · {signalLabel(d.rssi)} ({d.rssi} dBm)
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}

      <p aria-live="polite" className="net-hint">
        {error ? "" : progressText()}
      </p>
      {showProgress && (
        <progress
          max={status.total}
          value={status.done ?? 0}
          aria-label={t("Напредък")}
        />
      )}
      {error && <p role="alert">{t(error)}</p>}

      <div className="call-actions">
        {error && (
          <button onClick={onRetry}>{t("Опитай пак")}</button>
        )}
        <button className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </div>
  );
}
