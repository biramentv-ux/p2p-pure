import { useEffect, useRef } from "react";
import type { CallSnapshot } from "../../call/callController";

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
  const remoteVideo = useStream(call.kind === "video" ? call.remote : null);
  const remoteAudio = useStream(call.kind === "audio" ? call.remote : null);
  const localVideo = useStream(call.kind === "video" ? call.local : null);
  const kindLabel = call.kind === "video" ? "видео" : "аудио";

  if (call.phase === "idle") return null;

  if (call.phase === "incoming") {
    return (
      <section className="call-panel" aria-label="Входящ разговор">
        <p>
          <strong>{contactName}</strong> ти звъни: {kindLabel} разговор.
        </p>
        <div className="call-actions">
          <button onClick={onAccept}>Приеми</button>
          <button className="secondary" onClick={onDecline}>
            Откажи
          </button>
        </div>
      </section>
    );
  }

  if (call.phase === "outgoing" || call.phase === "connecting" || call.phase === "active") {
    const label =
      call.phase === "outgoing" ? "Звъня…" : call.phase === "connecting" ? "Свързвам разговора…" : "В разговор";
    return (
      <section className="call-panel" aria-label="Разговор">
        <p role="status">
          {label} ({kindLabel})
        </p>
        {call.kind === "video" && (
          <div className="call-video">
            <video ref={remoteVideo} autoPlay playsInline aria-label="Видео на събеседника" />
            <video ref={localVideo} autoPlay playsInline muted aria-label="Твоето видео" className="call-self" />
          </div>
        )}
        {call.kind === "audio" && <audio ref={remoteAudio} autoPlay />}
        <div className="call-actions">
          <button className="secondary" onClick={onToggleMute} aria-pressed={call.muted}>
            {call.muted ? "Включи микрофона" : "Заглуши"}
          </button>
          {call.kind === "video" && (
            <button className="secondary" onClick={onToggleCamera} aria-pressed={call.cameraOff}>
              {call.cameraOff ? "Включи камерата" : "Изключи камерата"}
            </button>
          )}
          <button onClick={onHangup}>Край</button>
        </div>
        {call.error && <p role="alert">{call.error}</p>}
      </section>
    );
  }

  // ended
  return (
    <section className="call-panel" aria-label="Разговорът приключи">
      <p>Разговорът приключи.</p>
      {call.error && <p role="alert">{call.error}</p>}
    </section>
  );
}
