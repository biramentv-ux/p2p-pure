import type { CallKind } from "./signal";

/** Asks for the microphone, and the camera for video calls. Rejects if the person refuses. */
export async function acquireMedia(kind: CallKind): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Устройството не поддържа аудио и видео.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: kind === "video" ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
  });
}
