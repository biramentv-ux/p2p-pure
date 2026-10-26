import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";

const STEP = 0.1;
const clamp = (v: number) => Math.min(1, Math.max(0, Math.round(v * 10) / 10));

/** Volume is shared by every player on the screen, so changing it once is enough. */
let sharedVolume = 1;
const volumeListeners = new Set<(v: number) => void>();
function setSharedVolume(v: number) {
  sharedVolume = v;
  for (const listener of volumeListeners) listener(v);
}
/** Only one track plays at a time: starting one stops the one before it. */
let playing: HTMLAudioElement | null = null;

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface AudioPlayerProps {
  /** Object URL of the audio blob. */
  src: string;
  name: string;
  /** Start right away (the person just tapped "Play"). */
  autoPlay?: boolean;
}

/** A small music player: play/pause, a seek bar, the time, and volume − / +. */
export function AudioPlayer({ src, name, autoPlay = false }: AudioPlayerProps) {
  const { t } = useI18n();
  const audio = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(sharedVolume);
  const [failed, setFailed] = useState(false);

  // Every mounted player follows the shared volume, not only the one whose button was pressed.
  useEffect(() => {
    const follow = (v: number) => {
      setVolume(v);
      if (audio.current) audio.current.volume = v;
    };
    volumeListeners.add(follow);
    return () => {
      volumeListeners.delete(follow);
    };
  }, []);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.volume = sharedVolume;
    if (autoPlay) void el.play().catch(() => setIsPlaying(false));
    return () => {
      el.pause();
      if (playing === el) playing = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setFailed(true));
    else el.pause();
  }

  function change(delta: number) {
    setSharedVolume(clamp(volume + delta));
  }

  const percent = Math.round(volume * 100);
  // The file stays downloadable, also when this browser cannot play its codec.
  const download = (
    <a className="file-download" href={src} download={name}>
      {t("Изтегли")}
    </a>
  );
  if (failed)
    return (
      <span className="msg-file">
        <span className="file-meta">
          <strong>{name}</strong>
          <small>{t("Този звук не може да се пусне.")}</small>
        </span>
        {download}
      </span>
    );
  return (
    <span className="audio-player" role="group" aria-label={name}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={(e) => {
          if (playing && playing !== e.currentTarget) playing.pause();
          playing = e.currentTarget;
          setIsPlaying(true);
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setFailed(true)}
      />
      <strong className="audio-name">{name}</strong>
      <span className="audio-row">
        <button type="button" className="secondary audio-play" onClick={toggle} aria-label={isPlaying ? t("Пауза") : t("Пусни")}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          className="audio-seek"
          min={0}
          max={duration > 0 ? duration : 1}
          step={0.1}
          value={Math.min(time, duration > 0 ? duration : 1)}
          disabled={!(duration > 0)}
          aria-label={t("Позиция в записа")}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (audio.current) audio.current.currentTime = v;
            setTime(v);
          }}
        />
        <small className="audio-time">
          {clock(time)} / {clock(duration)}
        </small>
      </span>
      <span className="audio-row audio-volume">
        <button type="button" className="secondary" onClick={() => change(-STEP)} disabled={volume <= 0} aria-label={t("По-тихо")}>
          −
        </button>
        <small role="status" aria-label={t("Сила на звука")}>
          {t("Звук {percent}%", { percent })}
        </small>
        <button type="button" className="secondary" onClick={() => change(STEP)} disabled={volume >= 1} aria-label={t("По-силно")}>
          +
        </button>
        {download}
      </span>
    </span>
  );
}
