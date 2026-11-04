import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  encodeLightFrames,
  estimateLightDurationMs,
  LIGHT_FPS,
  LightDecoder,
  rasterizeFrame,
  type LightFrame,
} from "../../p2p/light/lightCodec";
import { useI18n } from "../../i18n";

/**
 * Light pairing ("QR one way, light back", M14).
 * - role "show": the responder shows its compact answer as an animated grid of coloured cells.
 *   Photosensitivity: a warning and an explicit start button come first, the animation never
 *   starts on its own, a stop button is always visible, and it never runs faster than LIGHT_FPS.
 * - role "read": the initiator reads the animation with its camera and hands the bytes up.
 * The camera, the animation and the wake lock all stop when the panel goes away.
 */
export type LightPairingPanelProps =
  | { role: "show"; bytes: Uint8Array; onShowQr(): void }
  | { role: "read"; onBytes(bytes: Uint8Array): void };

/** After this long of showing without a connection, suggest the QR code instead. */
const QR_HINT_AFTER_MS = 20_000;
/** Camera frames are scaled down to this width before decoding. */
const READ_WIDTH = 640;
/** How often a camera frame goes to the decoder (about 10 per second). */
const READ_INTERVAL_MS = 100;
/** Upper bound for the canvas backing store; CSS scales it up with crisp pixels. */
const MAX_RASTER_PX = 480;

export function LightPairingPanel(props: LightPairingPanelProps) {
  return props.role === "show" ? (
    <ShowPanel bytes={props.bytes} onShowQr={props.onShowQr} />
  ) : (
    <ReadPanel onBytes={props.onBytes} />
  );
}

function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/* ---------- Responder: show the answer as light ---------- */

interface WakeLockHandle {
  release(): Promise<void>;
}
type WakeLockApi = { request(type: "screen"): Promise<WakeLockHandle> };

function ShowPanel({ bytes, onShowQr }: { bytes: Uint8Array; onShowQr(): void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"warn" | "playing" | "stopped" | "error">("warn");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [cssSize, setCssSize] = useState(280);
  const reduced = useState(reducedMotion)[0];

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<LightFrame[] | null>(null);
  const rasterRef = useRef<{ size: number; images: ImageData[] } | null>(null);
  const indexRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const wakeRef = useRef<WakeLockHandle | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const period = 1000 / LIGHT_FPS;
  const seconds = Math.max(1, Math.ceil(estimateLightDurationMs(bytes.length) / 1000));
  const playing = phase === "playing";

  function clearTimers() {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  async function requestWakeLock() {
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api || wakeRef.current) return;
    try {
      wakeRef.current = await api.request("screen");
    } catch {
      // Not granted (battery saver, unsupported): the animation still works.
    }
  }

  function releaseWakeLock() {
    const lock = wakeRef.current;
    wakeRef.current = null;
    if (lock) void lock.release().catch(() => undefined);
  }

  // Everything stops when the panel goes away.
  useEffect(
    () => () => {
      clearTimers();
      releaseWakeLock();
    },
    [],
  );

  // Keep the canvas square and as large as fits the panel width and most of the screen height.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const width = wrap.clientWidth || 280;
      const height = Math.round((globalThis.innerHeight || 600) * 0.7);
      setCssSize(Math.max(120, Math.floor(Math.min(width, height))));
    };
    measure();
    const Observer = globalThis.ResizeObserver;
    if (Observer) {
      const ro = new Observer(measure);
      ro.observe(wrap);
      return () => ro.disconnect();
    }
    globalThis.addEventListener("resize", measure);
    return () => globalThis.removeEventListener("resize", measure);
  }, [phase]);

  function rasterFor(size: number): ImageData[] | null {
    const frames = framesRef.current;
    if (!frames) return null;
    const cached = rasterRef.current;
    if (cached && cached.size === size) return cached.images;
    const images = frames.map((f) => {
      const image = new ImageData(size, size);
      image.data.set(rasterizeFrame(f, size, size));
      return image;
    });
    rasterRef.current = { size, images };
    return images;
  }

  const rasterPx = Math.min(MAX_RASTER_PX, Math.round(cssSize * (globalThis.devicePixelRatio || 1)));

  function drawNext() {
    rafRef.current = null;
    const canvas = canvasRef.current;
    const images = rasterFor(rasterPx);
    if (!canvas || !images || images.length === 0) return;
    if (canvas.width !== rasterPx) canvas.width = rasterPx;
    if (canvas.height !== rasterPx) canvas.height = rasterPx;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const i = indexRef.current % images.length;
    ctx.putImageData(images[i], 0, 0);
    indexRef.current = (i + 1) % images.length;
    // The next frame waits a full period after this one was drawn: never faster than LIGHT_FPS.
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      rafRef.current = requestAnimationFrame(() => drawRef.current());
    }, period);
  }
  // The running carousel always calls the latest drawNext (current size and frames).
  const drawRef = useRef(drawNext);
  useEffect(() => {
    drawRef.current = drawNext;
  });

  // Run the carousel while playing and visible; pause when the tab is hidden.
  useEffect(() => {
    if (!playing || paused) return;
    clearTimers();
    rafRef.current = requestAnimationFrame(() => drawRef.current());
    return clearTimers;
  }, [playing, paused, rasterPx]);

  useEffect(() => {
    if (!playing) return;
    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      setPaused(hidden);
      // The browser drops the wake lock when the tab is hidden; take it again on return.
      if (hidden) releaseWakeLock();
      else void requestWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [playing]);

  // No connection after a while: point at the QR code.
  useEffect(() => {
    if (phase === "warn" || hint) return;
    const startedAt = startedAtRef.current ?? Date.now();
    const left = Math.max(0, QR_HINT_AFTER_MS - (Date.now() - startedAt));
    const id = setTimeout(() => setHint(true), left);
    return () => clearTimeout(id);
  }, [phase, hint]);

  function start() {
    setError(null);
    if (!framesRef.current) {
      try {
        framesRef.current = encodeLightFrames(bytes);
        rasterRef.current = null;
      } catch {
        setPhase("error");
        setError(t("Отговорът не може да се превърне в светлинна анимация. Покажи QR кода."));
        return;
      }
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    indexRef.current = 0;
    setPaused(typeof document !== "undefined" && document.visibilityState === "hidden");
    setPhase("playing");
    void requestWakeLock();
  }

  function stop() {
    clearTimers();
    releaseWakeLock();
    setPhase("stopped");
  }

  let status: string;
  if (phase === "warn") status = t("Анимацията още не е пусната.");
  else if (phase === "error") status = t("Анимацията е спряна.");
  else if (phase === "stopped") status = t("Анимацията е спряна. Чакам връзката…");
  else if (paused) status = t("Анимацията е на пауза, докато екранът е скрит.");
  else status = t("Показвам отговора… Насочи екрана към камерата на другото устройство.");

  const canvasStyle: CSSProperties = {
    width: cssSize,
    height: cssSize,
    imageRendering: "pixelated",
    display: "block",
    margin: "0 auto",
    borderRadius: 8,
  };

  return (
    <section className="light-panel" aria-label={t("Отговор като светлина")}>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      {(phase === "warn" || phase === "stopped") && (
        <div role="note">
          <p>
            <strong>
              {t(
                "Анимацията сменя цветни квадратчета 3 пъти в секунда. Ако сте чувствителни към мигаща светлина, използвайте QR кода.",
              )}
            </strong>
          </p>
          {reduced && (
            <p>{t("Устройството ви е настроено да намалява движението. Препоръчваме QR кода.")}</p>
          )}
          <p>{t("Един цикъл трае около {s} секунди. Анимацията се повтаря, докато не я спреш.", { s: seconds })}</p>
          <p>{t("Увеличи яркостта на екрана до максимум.")}</p>
        </div>
      )}
      <div ref={wrapRef} style={{ width: "100%" }}>
        {playing && (
          <canvas
            ref={canvasRef}
            width={rasterPx}
            height={rasterPx}
            style={canvasStyle}
            role="img"
            aria-label={t("Светлинна анимация с отговора")}
          />
        )}
      </div>
      {playing ? (
        <button type="button" onClick={stop}>
          {t("Спри анимацията")}
        </button>
      ) : (
        phase !== "error" && (
          <button type="button" onClick={start}>
            {phase === "stopped"
              ? t("Пусни анимацията отново")
              : reduced
              ? t("Покажи анимацията въпреки това")
              : t("Разбрах, пусни анимацията")}
          </button>
        )
      )}
      {hint && <p role="note">{t("Не се получава? Покажи QR кода вместо анимацията.")}</p>}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          stop();
          onShowQr();
        }}
      >
        {t("Покажи QR вместо това")}
      </button>
    </section>
  );
}

/* ---------- Initiator: read the light with the camera ---------- */

function cameraErrorMessage(err: unknown, t: (s: string) => string): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("Няма разрешение за камерата. Разреши я в настройките на браузъра или сканирай QR отговора.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return t("Не е намерена камера. Сканирай QR отговора.");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return t("Камерата е заета от друго приложение. Затвори го и опитай пак.");
  }
  return t("Камерата не можа да се включи. Сканирай QR отговора.");
}

/** Phones read the other screen with the back camera; laptops with the webcam. */
function prefersBackCamera(): boolean {
  try {
    const ua = navigator.userAgent ?? "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    return globalThis.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

function ReadPanel({ onBytes }: { onBytes(bytes: Uint8Array): void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<"idle" | "starting" | "reading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState(0);
  const [back, setBack] = useState(prefersBackCamera);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderRef = useRef<LightDecoder | null>(null);
  const runRef = useRef(0);
  const doneRef = useRef(false);
  const onBytesRef = useRef(onBytes);
  useEffect(() => {
    onBytesRef.current = onBytes;
  }, [onBytes]);

  function stopCamera() {
    runRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }

  // The camera never outlives the panel.
  useEffect(() => () => stopCamera(), []);

  function readFrame(run: number) {
    timerRef.current = null;
    if (run !== runRef.current || doneRef.current) return;
    const video = videoRef.current;
    const decoder = decoderRef.current;
    if (video && decoder && video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      const canvas = (canvasRef.current ??= document.createElement("canvas"));
      const scale = Math.min(1, READ_WIDTH / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, w, h);
        const image = ctx.getImageData(0, 0, w, h);
        try {
          decoder.push({ data: image.data, width: image.width, height: image.height });
        } catch {
          // A bad frame is just skipped; the carousel comes round again.
        }
        const result = decoder.result;
        if (result) {
          doneRef.current = true;
          stopCamera();
          setPhase("idle");
          onBytesRef.current(result);
          return;
        }
        setLocked(decoder.locked);
        setProgress(decoder.progress);
      }
    }
    timerRef.current = setTimeout(() => readFrame(run), READ_INTERVAL_MS);
  }

  async function start(useBack = back) {
    stopCamera();
    const run = runRef.current;
    doneRef.current = false;
    decoderRef.current = new LightDecoder();
    setLocked(false);
    setProgress(0);
    setError(null);
    setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Камерата не е достъпна в този контекст (нужен е HTTPS или localhost).");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: useBack ? "environment" : "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      if (run !== runRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => {
          if (run !== runRef.current) return;
          stopCamera();
          setPhase("error");
          setError(t("Камерата спря. Включи я отново или сканирай QR отговора."));
        });
      }
      const video = videoRef.current;
      if (!video) throw new Error("no video element");
      video.srcObject = stream;
      await video.play();
      if (run !== runRef.current) return;
      setPhase("reading");
      timerRef.current = setTimeout(() => readFrame(run), READ_INTERVAL_MS);
    } catch (err) {
      if (run !== runRef.current) return;
      stopCamera();
      setPhase("error");
      setError(
        err instanceof Error && err.message.startsWith("Камерата не е достъпна")
          ? t(err.message)
          : cameraErrorMessage(err, t),
      );
    }
  }

  const active = phase === "reading" || phase === "starting";
  let status: string;
  if (phase === "idle") status = t("Включи камерата, за да прочетеш отговора като светлина.");
  else if (phase === "starting") status = t("Включвам камерата…");
  else if (phase === "error") status = t("Камерата е изключена.");
  else if (locked) status = t("Намерих анимацията. Дръж камерата неподвижно…");
  else status = t("Търся анимацията… Насочи камерата към екрана на другото устройство.");

  const guide: CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: "70%",
    aspectRatio: "1 / 1",
    maxHeight: "85%",
    transform: "translate(-50%, -50%)",
    border: `3px dashed ${locked ? "#3ccf7a" : "rgba(255,255,255,0.85)"}`,
    borderRadius: 12,
    boxShadow: "0 0 0 9999px rgba(0,0,0,0.25)",
    pointerEvents: "none",
  };

  return (
    <section className="light-panel" aria-label={t("Отговор като светлина")}>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {error && <p role="alert">{error}</p>}
      <div style={{ position: "relative", overflow: "hidden", display: active ? "block" : "none" }}>
        <video
          ref={videoRef}
          playsInline
          muted
          className="scanner-video"
          aria-label={t("Изглед от камерата")}
          style={{ transform: back ? undefined : "scaleX(-1)" }}
        />
        <div style={guide} aria-hidden="true" />
      </div>
      {phase === "reading" && (
        <>
          <p aria-hidden="true">{locked ? t("Намерено") : t("Търся")}</p>
          <label>
            {t("Получено")}
            <progress max={1} value={progress} />
          </label>
        </>
      )}
      {(phase === "idle" || phase === "error") && (
        <button type="button" onClick={() => void start()}>
          {t("Включи камерата")}
        </button>
      )}
      {active && (
        <>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const next = !back;
              setBack(next);
              void start(next);
            }}
          >
            {t("Смени камерата")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              stopCamera();
              setPhase("idle");
            }}
          >
            {t("Спри камерата")}
          </button>
        </>
      )}
    </section>
  );
}
