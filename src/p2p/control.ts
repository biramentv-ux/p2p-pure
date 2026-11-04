/**
 * Control messages carried inside the encrypted chat channel:
 *  - loc:  a location the sender chose to share
 *  - wipe: "delete this chat on both sides"
 *  - suite: agreement on the cipher suite (see suiteNegotiation.ts)
 *  - intro-*: introduction through a mutual contact (src/intro, docs/INTRODUCTIONS.md)
 *
 * Plaintext format: CONTROL_MARK + JSON. User text cannot carry the mark, because the
 * chat sanitizes the \u0001 byte out of typed text.
 */
import { FRAME_MARK } from "./photo";
import { validLocation, type LocationFix } from "../history/messageStore";
import { validSuiteMessage, type SuiteMessage } from "./suiteNegotiation";
import { introToJson, isIntroType, validIntroMessage, type IntroMessage } from "../intro/introMessages";

export type { IntroMessage } from "../intro/introMessages";

export const CONTROL_MARK = `${FRAME_MARK}K|`;

export type ControlMessage = { t: "loc"; fix: LocationFix } | { t: "wipe" } | SuiteMessage;

/** Everything that can be encoded on the control channel, introductions included. */
export type AnyControlMessage = ControlMessage | IntroMessage;

/** True for the introduction messages (intro-request, intro-offer, ...). */
export function isIntroControl(message: AnyControlMessage): message is IntroMessage {
  return isIntroType(message.t);
}

export function encodeControl(message: AnyControlMessage): string {
  if (isIntroControl(message)) {
    return CONTROL_MARK + introToJson(message);
  }
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

function parseControl(plaintext: string): Record<string, unknown> | null {
  if (!isControlMessage(plaintext)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.slice(CONTROL_MARK.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  return raw as Record<string, unknown>;
}

/**
 * An introduction message (src/intro), or null. Kept apart from decodeControl: the chat screen
 * does not handle introductions, so for it they decode to null and are ignored.
 */
export function decodeIntroControl(plaintext: string): IntroMessage | null {
  const o = parseControl(plaintext);
  return o && isIntroType(o.t) ? validIntroMessage(o) : null;
}

/** Returns the message, or null for anything malformed or out of range (and for introductions). */
export function decodeControl(plaintext: string): ControlMessage | null {
  const o = parseControl(plaintext);
  if (!o) return null;
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
