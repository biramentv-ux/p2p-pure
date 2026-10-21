import { useEffect, useRef } from "react";
import type { CallSnapshot } from "../../call/callController";
import { useI18n } from "../../i18n";

interface CallPanelProps {
  call: CallSnapshot;
  contactName: string;
  onAccept: () => void;
  onDecline: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}

/** Binds a MediaStream to a media element. */
function useStream(stream: MediaStream | null) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return ref;
}

export function CallPanel({ call, contactName, onAccept, onDecline, onHangup, onToggleMute, onToggleCamera }: CallPanelProps) {
  const { t } = useI18n();
  const remoteVideo = useStream(call.kind === "video" ? call.remote : null);
  const remoteAudio = useStream(call.kind === "audio" ? call.remote : null);
  const localVideo = useStream(call.kind === "video" ? call.local : null);
  const kindLabel = t(call.kind === "video" ? "видео" : "аудио");

  if (call.phase === "idle") return null;

  if (call.phase === "incoming") {
    return (
      <section className="call-panel" aria-label={t("Входящ разговор")}>
        <p>{t("{name} ти звъни: {kind} разговор.", { name: contactName, kind: kindLabel })}</p>
        <div className="call-actions">
          <button onClick={onAccept}>{t("Приеми")}</button>
          <button className="secondary" onClick={onDecline}>
            {t("Откажи")}
          </button>
        </div>
      </section>
    );
  }

  if (call.phase === "outgoing" || call.phase === "connecting" || call.phase === "active") {
    const label =
      call.phase === "outgoing"
        ? t("Звъня…")
        : call.phase === "connecting"
          ? t("Свързвам разговора…")
          : t("В разговор");
    return (
      <section className="call-panel" aria-label={t("Разговор")}>
        <p role="status">{t("{label} ({kind})", { label, kind: kindLabel })}</p>
        {call.kind === "video" && (
          <div className="call-video">
            <video ref={remoteVideo} autoPlay playsInline aria-label={t("Видео на събеседника")} />
            <video ref={localVideo} autoPlay playsInline muted aria-label={t("Твоето видео")} className="call-self" />
          </div>
        )}
        {call.kind === "audio" && <audio ref={remoteAudio} autoPlay />}
        <div className="call-actions">
          <button className="secondary" onClick={onToggleMute} aria-pressed={call.muted}>
            {call.muted ? t("Включи микрофона") : t("Заглуши")}
          </button>
          {call.kind === "video" && (
            <button className="secondary" onClick={onToggleCamera} aria-pressed={call.cameraOff}>
              {call.cameraOff ? t("Включи камерата") : t("Изключи камерата")}
            </button>
          )}
          <button onClick={onHangup}>{t("Край")}</button>
        </div>
        {call.error && <p role="alert">{t(call.error)}</p>}
      </section>
    );
  }

  // ended
  return (
    <section className="call-panel" aria-label={t("Разговорът приключи")}>
      <p>{t("Разговорът приключи.")}</p>
      {call.error && <p role="alert">{t(call.error)}</p>}
    </section>
  );
}
