import { useEffect, useRef, useState } from "react";
import { decodeQrFromPixels } from "../../p2p/qrDecode";

interface QrScannerProps {
  /** Called exactly once with the first decoded QR text. */
  onDetected: (text: string) => void;
}

const MAX_SCAN_WIDTH = 640;

export function QrScanner({ onDetected }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let cancelled = false;
    let detected = false;

    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };

    const tick = () => {
      if (cancelled || detected) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_SCAN_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const text = decodeQrFromPixels(pixels.data, pixels.width, pixels.height);
          if (text) {
            detected = true;
            stop();
            onDetectedRef.current(text);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Камерата не е достъпна в този контекст (нужен е HTTPS или localhost).");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        frame = requestAnimationFrame(tick);
      } catch (err) {
        setCameraError(err instanceof Error ? err.message : "Камерата не може да бъде стартирана.");
      }
    })();

    return stop;
  }, []);

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted className="scanner-video" />
      <canvas ref={canvasRef} hidden />
      {cameraError && <p role="alert">Камера: {cameraError}</p>}
      <details>
        <summary>Няма камера? Постави кода ръчно</summary>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={4}
          placeholder="p2p1:…"
          aria-label="Поканен код"
        />
        <button
          type="button"
          disabled={!pasted.trim()}
          onClick={() => onDetectedRef.current(pasted.trim())}
        >
          Използвай кода
        </button>
      </details>
    </div>
  );
}
