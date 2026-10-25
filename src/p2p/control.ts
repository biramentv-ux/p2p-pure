/**
 * Control messages carried inside the encrypted chat channel:
 *  - loc:  a location the sender chose to share
 *  - wipe: "delete this chat on both sides"
 *  - suite: agreement on the cipher suite (see suiteNegotiation.ts)
 *
 * Plaintext format: CONTROL_MARK + JSON. User text cannot carry the mark, because the
 * chat sanitizes the \u0001 byte out of typed text.
 */
import { FRAME_MARK } from "./photo";
import { validLocation, type LocationFix } from "../history/messageStore";
import { validSuiteMessage, type SuiteMessage } from "./suiteNegotiation";

export const CONTROL_MARK = `${FRAME_MARK}K|`;

export type ControlMessage = { t: "loc"; fix: LocationFix } | { t: "wipe" } | SuiteMessage;

export function encodeControl(message: ControlMessage): string {
  if (message.t === "suite") {
    return CONTROL_MARK + JSON.stringify(message);
  }
  if (message.t === "loc") {
    return CONTROL_MARK + JSON.stringify({ t: "loc", lat: message.fix.lat, lng: message.fix.lng, accuracy: message.fix.accuracy });
  }
  return CONTROL_MARK + JSON.stringify({ t: "wipe" });
}

export function isControlMessage(plaintext: string): boolean {
  return plaintext.startsWith(CONTROL_MARK);
}

/** Returns the message, or null for anything malformed or out of range. */
export function decodeControl(plaintext: string): ControlMessage | null {
  if (!isControlMessage(plaintext)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.slice(CONTROL_MARK.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.t === "wipe") return { t: "wipe" };
  if (o.t === "suite") return validSuiteMessage(o);
  if (o.t === "loc") {
    const fix = validLocation({
      lat: o.lat as number,
      lng: o.lng as number,
      accuracy: o.accuracy as number,
    });
    return fix ? { t: "loc", fix } : null;
  }
  return null;
}
