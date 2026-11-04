import { useEffect, useRef, useState } from "react";
import { encodeToSamples, estimateDurationMs, FskDecoder } from "../../p2p/audio/fskModem";
import { isAudioPairingSupported, playSamples, startListening } from "../../p2p/audio/audioIo";
import { useI18n } from "../../i18n";

/**
 * Sound pairing ("QR one way, sound back").
 * - role "play": the responder plays its compact answer as sound. Audio starts only on a button
 *   press, because iOS allows sound only after a user gesture.
 * - role "listen": the initiator listens with the microphone and hands the decoded bytes up.
 * The microphone and any playing sound stop when the panel goes away (success, cancel, errors).
 */
export type SoundPairingPanelProps =
  | { role: "play"; bytes: Uint8Array; onShowQr(): void }
  | { role: "listen"; onBytes(bytes: Uint8Array): void };

/** After this long of playing without a connection, suggest the QR code instead. */
const QR_HINT_AFTER_MS = 20_000;
/** How often the level meter and progress bar are refreshed. */
const UI_TICK_MS = 100;

export function SoundPairingPanel(props: SoundPairingPanelProps) {
  if (!isAudioPairingSupported()) return <NotSupported />;
  return props.role === "play" ? (
    <PlayPanel bytes={props.bytes} onShowQr={props.onShowQr} />
  ) : (
    <ListenPanel onBytes={props.onBytes} />
  );
}

function NotSupported() {
  const { t } = useI18n();
  return (
    <p role="alert">{t("Това устройство не поддържа сдвояване със звук. Използвайте QR кода.")}</p>
  );
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

/* ---------- Responder: play the answer ---------- */

function PlayPanel({ bytes, onShowQr }: { bytes: Uint8Array; onShowQr(): void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"idle" | "playing" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [showQrHint, setShowQrHint] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const durationMs = estimateDurationMs(bytes.length);
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));

  // Stop the sound and release the audio context when the panel goes away.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.close().catch(() => undefined);
    },
    [],
  );

  // Long transfers (or many replays) without a connection: point at the QR code.
  useEffect(() => {
    if (durationMs > QR_HINT_AFTER_MS) {
      setShowQrHint(true);
      return;
    }
    if (phase === "idle") return;
    const startedAt = startedAtRef.current ?? Date.now();
    const left = QR_HINT_AFTER_MS - (Date.now() - startedAt);
    if (left <= 0) {
      setShowQrHint(true);
      return;
    }
    const id = setTimeout(() => setShowQrHint(true), left);
    return () => clearTimeout(id);
  }, [phase, durationMs]);

  function play() {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    // Created and resumed inside the click handler: iOS only starts audio from a user gesture.
    let ctx = ctxRef.current;
    if (!ctx) {
      const Ctor = audioContextCtor();
      if (Ctor) {
        try {
          ctx = new Ctor();
          ctxRef.current = ctx;
        } catch {
          ctx = null;
        }
      }
    }
    if (ctx) void ctx.resume().catch(() => undefined);
    const sampleRate = ctx?.sampleRate ?? 48_000;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    setPhase("playing");
    let samples: Float32Array;
    try {
      samples = encodeToSamples(bytes, sampleRate);
    } catch {
      setPhase("error");
      setError(t("Отговорът не може да се превърне в звук. Покажи QR кода."));
      return;
    }
    playSamples(samples, { sampleRate, signal: abort.signal, audioContext: ctx ?? undefined })
      .then(() => {
        if (abortRef.current === abort) setPhase("done");
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setPhase("error");
        setError(t("Звукът не можа да се пусне. Увеличи звука и опитай пак или покажи QR кода."));
      });
  }

  const status =
    phase === "playing"
      ? t("Пускам отговора… Дръж телефона близо до другото устройство.")
      : phase === "done"
      ? t("Звукът свърши. Чакам връзката…")
      : t("Натисни бутона и дръж високоговорителя към другото устройство.");

  return (
    <section className="sound-panel" aria-label={t("Отговор като звук")}>
      <p>{t("Продължителност: около {s} секунди.", { s: seconds })}</p>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {phase === "idle" ? (
        <button type="button" onClick={play}>
          {t("Пусни отговора като звук")}
        </button>
      ) : (
        <button type="button" onClick={play} disabled={phase === "playing"}>
          {t("Пусни звука отново")}
        </button>
      )}
      {showQrHint && <p role="note">{t("Не се получава? Покажи QR кода вместо звука.")}</p>}
      <button type="button" className="secondary" onClick={onShowQr}>
        {t("Покажи QR вместо това")}
      </button>
    </section>
  );
}

/* ---------- Initiator: listen for the answer ---------- */

function micErrorMessage(err: unknown, t: (s: string) => string): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("Няма разрешение за микрофона. Разреши го в настройките на браузъра или сканирай QR отговора.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("Не е намерен микрофон. Сканирай QR отговора.");
  }
  if (name === "NotReadableError") {
    return t("Микрофонът е зает от друго приложение. Затвори го и опитай пак.");
  }
  return t("Микрофонът не можа да се включи. Сканирай QR отговора.");
}

function ListenPanel({ onBytes }: { onBytes(bytes: Uint8Array): void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState(0);
  const [locked, setLocked] = useState(false);
  const [garbled, setGarbled] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const handleRef = useRef<{ stop(): void } | null>(null);
  const decoderRef = useRef<{ decoder: FskDecoder; rate: number } | null>(null);
  const meterRef = useRef({ level: 0, progress: 0, locked: false, garbled: false });
  const doneRef = useRef(false);
  const onBytesRef = useRef(onBytes);
  useEffect(() => {
    onBytesRef.current = onBytes;
  }, [onBytes]);

  function stopMic() {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      handleRef.current?.stop();
    } catch {
      // Already stopped.
    }
    handleRef.current = null;
  }

  // The microphone never outlives the panel.
  useEffect(() => () => stopMic(), []);

  // Copy the meter values into state at a calm rate, not on every audio chunk.
  useEffect(() => {
    if (phase !== "listening") return;
    const id = setInterval(() => {
      const m = meterRef.current;
      setLevel(m.level);
      setProgress(m.progress);
      setLocked(m.locked);
      setGarbled(m.garbled);
    }, UI_TICK_MS);
    return () => clearInterval(id);
  }, [phase]);

  function onChunk(samples: Float32Array, sampleRate: number) {
    if (doneRef.current) return;
    let entry = decoderRef.current;
    if (!entry || entry.rate !== sampleRate) {
      entry = { decoder: new FskDecoder(sampleRate), rate: sampleRate };
      decoderRef.current = entry;
    }
    const { decoder } = entry;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
    const m = meterRef.current;
    // Smooth, and scale so normal speech or a phone speaker fills most of the bar.
    m.level = Math.min(1, Math.max(rms * 4, m.level * 0.8));
    const wasLocked = m.locked;
    decoder.push(samples);
    const result = decoder.result;
    if (result) {
      doneRef.current = true;
      stopMic();
      onBytesRef.current(result);
      return;
    }
    m.locked = decoder.locked;
    m.progress = decoder.progress;
    if (m.locked) m.garbled = false;
    // Lost the signal without a result: a bad frame (CRC). Keep listening for a replay.
    else if (wasLocked) {
      m.garbled = true;
      decoder.reset();
      m.progress = 0;
    }
  }

  async function start() {
    stopMic();
    doneRef.current = false;
    decoderRef.current = null;
    meterRef.current = { level: 0, progress: 0, locked: false, garbled: false };
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setPhase("starting");
    try {
      const handle = await startListening(onChunk, { signal: abort.signal });
      if (abort.signal.aborted) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
      setPhase("listening");
    } catch (err) {
      if (abort.signal.aborted) return;
      abortRef.current = null;
      setPhase("error");
      setError(micErrorMessage(err, t));
    }
  }

  let status: string;
  if (phase === "idle") status = t("Включи микрофона, за да чуеш отговора като звук.");
  else if (phase === "starting") status = t("Включвам микрофона…");
  else if (phase === "error") status = t("Микрофонът е изключен.");
  else if (locked) status = t("Чувам отговора…");
  else if (garbled) status = t("Звукът не се разчете. Нека другият човек го пусне отново.");
  else status = t("Слушам… Нека другият човек пусне отговора като звук.");

  return (
    <section className="sound-panel" aria-label={t("Отговор като звук")}>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {phase === "listening" && (
        <>
          <label>
            {t("Сила на звука")}
            <meter min={0} max={1} low={0.15} high={0.9} optimum={0.5} value={level} />
          </label>
          <label>
            {t("Получено")}
            <progress max={1} value={progress} />
          </label>
        </>
      )}
      {(phase === "idle" || phase === "error") && (
        <button type="button" onClick={() => void start()}>
          {t("Включи микрофона")}
        </button>
      )}
      {(phase === "listening" || phase === "starting") && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            stopMic();
            setPhase("idle");
          }}
        >
          {t("Спри микрофона")}
        </button>
      )}
    </section>
  );
}
