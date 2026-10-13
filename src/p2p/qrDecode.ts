import jsQR from "jsqr";

/**
 * Pure decode step: RGBA pixels in, QR text out (or null).
 * Kept free of DOM/camera APIs so the same code path is exercised by tests.
 */
export function decodeQrFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: "dontInvert" });
  return result ? result.data : null;
}
