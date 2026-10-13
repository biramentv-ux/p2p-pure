import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

interface QrCodeProps {
  data: string;
  /** Target size in CSS pixels. The module scale is rounded to an integer. */
  size?: number;
  label?: string;
}

const QUIET_ZONE_MODULES = 2;

export function QrCode({ data, size = 260, label = "QR код" }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Integer pixels per module keep edges sharp. Fractional scaling blurs the
    // modules and makes the code unreadable for scanners.
    const qr = QRCode.create(data, { errorCorrectionLevel: "M" });
    const moduleCount = qr.modules.size;
    const scale = Math.max(2, Math.floor(size / (moduleCount + QUIET_ZONE_MODULES * 2)));
    QRCode.toCanvas(canvas, data, {
      errorCorrectionLevel: "M",
      margin: QUIET_ZONE_MODULES,
      scale,
    }).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to render QR code");
    });
  }, [data, size]);

  if (error) {
    return <div className="qr-error" role="alert">QR грешка: {error}</div>;
  }

  return <canvas ref={canvasRef} aria-label={label} className="qr-canvas" />;
}
