/**
 * Prepares a photo for sending: decodes it with the right orientation, scales it
 * down and re-encodes it as JPEG. Re-encoding also drops EXIF data (GPS position,
 * camera model), so nothing the user did not intend to share leaves the device.
 */
import { MAX_PHOTO_BYTES } from "../p2p/photo";

const MAX_SIDE = 1280;
const QUALITIES = [0.8, 0.7, 0.6, 0.5];

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch {
      // fall through to the <img> path (some browsers reject the options or the format)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** `maxBytes` and `maxSide` default to the chat photo limits; the group photo uses smaller ones. */
export async function prepareImage(
  file: File,
  { maxBytes = MAX_PHOTO_BYTES, maxSide = MAX_SIDE }: { maxBytes?: number; maxSide?: number } = {},
): Promise<Uint8Array> {
  if (!file.type.startsWith("image/")) throw new Error("Избери снимка.");
  const img = await decode(file).catch(() => {
    throw new Error("Снимката не може да се прочете.");
  });
  try {
    let side = maxSide;
    for (let attempt = 0; attempt < 4; attempt++) {
      const scale = Math.min(1, side / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Снимката не може да се обработи.");
      ctx.fillStyle = "#fff"; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
      for (const q of QUALITIES) {
        const blob = await toBlob(canvas, q);
        if (!blob) throw new Error("Снимката не може да се обработи.");
        if (blob.size <= maxBytes) return new Uint8Array(await blob.arrayBuffer());
      }
      side = Math.round(side * 0.75);
    }
    throw new Error("Снимката е прекалено голяма.");
  } finally {
    img.done();
  }
}
