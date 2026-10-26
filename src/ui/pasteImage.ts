import { useEffect, useRef } from "react";

/** Types the paste may carry that we accept. SVG is left out on purpose: it can hold scripts. */
const PASTE_IMAGE = /^image\/(png|jpeg|webp|gif|bmp)$/;

const EXTENSION: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" };

/** The first image in a paste (Ctrl+V of a screenshot or a copied picture), or null for text. */
export function imageFromPaste(data: Pick<DataTransfer, "items"> | null | undefined, now = Date.now()): File | null {
  const items = data?.items;
  if (!items) return null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file" || !PASTE_IMAGE.test(item.type)) continue;
    const file = item.getAsFile();
    if (!file || file.size === 0) continue;
    // Pasted pictures usually come without a name ("image.png"); give each a unique one.
    const name = `paste-${new Date(now).toISOString().replace(/[:.]/g, "-")}.${EXTENSION[item.type]}`;
    return new File([file], name, { type: item.type });
  }
  return null;
}

/**
 * While `enabled`, a picture pasted anywhere on the screen is handed to `onImage` instead of
 * being typed into a field. Plain text pastes are left alone.
 */
export function usePasteImage(enabled: boolean, onImage: (file: File) => void): void {
  const handler = useRef(onImage);
  useEffect(() => {
    handler.current = onImage;
  });
  useEffect(() => {
    if (!enabled) return;
    function onPaste(e: ClipboardEvent) {
      const file = imageFromPaste(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      handler.current(file);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [enabled]);
}
