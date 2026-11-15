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

/** A new camera track facing the given way (switching cameras during a video call). */
export async function acquireCamera(facing: "user" | "environment"): Promise<MediaStreamTrack> {
  const s = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
  });
  return s.getVideoTracks()[0];
}

/** The screen (or a window) as a video track. Null where the browser cannot share a screen. */
export const acquireScreen: (() => Promise<MediaStreamTrack>) | undefined =
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function"
    ? async () => (await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false })).getVideoTracks()[0]
    : undefined;

/** True when the device has more than one camera (front and back). */
export async function hasSeveralCameras(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length > 1;
  } catch {
    return false;
  }
}

/** Where network changes are announced: the window ("online") and the Network Information API. */
export function networkTargets(): EventTarget[] {
  const out: EventTarget[] = [];
  if (typeof window !== "undefined") out.push(window);
  const conn = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: EventTarget }).connection : undefined;
  if (conn && typeof conn.addEventListener === "function") out.push(conn);
  return out;
}
