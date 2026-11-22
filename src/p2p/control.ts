/**
 * Control messages carried inside the encrypted chat channel:
 *  - loc:  a location the sender chose to share
 *  - wipe: "delete this chat on both sides"
 *  - timer: disappearing messages for this chat (ms, one of DISAPPEAR_OPTIONS; 0 = off)
 *  - suite: agreement on the cipher suite (see suiteNegotiation.ts)
 *  - intro-*: introduction through a mutual contact (src/intro, docs/INTRODUCTIONS.md)
 *  - vouch-*: key continuity (П7, src/trust, docs/KEY-CONTINUITY.md):
 *      vouch-grant  "I checked you: you are the new key of <old>" (a signed statement for the receiver to keep)
 *      vouch-ask    "show me the statements that you are the new key of <old>"
 *      vouch-list   the answer: those statements (at most MAX_VOUCHES)
 *
 * Plaintext format: CONTROL_MARK + JSON. User text cannot carry the mark, because the
 * chat sanitizes the \u0001 byte out of typed text.
 */
import { FRAME_MARK } from "./photo";
import { validLocation, type LocationFix } from "../history/messageStore";
import { validSuiteMessage, type SuiteMessage } from "./suiteNegotiation";
import { validDisappearMs } from "../history/disappearing";
import { introToJson, isIntroType, validDidKey, validIntroMessage, type IntroMessage } from "../intro/introMessages";
import { MAX_VOUCHES, parseVouch, type Vouch } from "../trust/vouch";

export type { IntroMessage } from "../intro/introMessages";

export const CONTROL_MARK = `${FRAME_MARK}K|`;

export type VouchMessage = { t: "vouch-grant"; v: Vouch } | { t: "vouch-ask"; old: string } | { t: "vouch-list"; old: string; vs: Vouch[] };

export type ControlMessage = { t: "loc"; fix: LocationFix } | { t: "wipe" } | { t: "timer"; ms: number; at: number } | SuiteMessage | VouchMessage;

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
  if (message.t === "vouch-grant") return CONTROL_MARK + JSON.stringify({ t: message.t, v: message.v });
  if (message.t === "vouch-ask") return CONTROL_MARK + JSON.stringify({ t: message.t, old: message.old });
  if (message.t === "vouch-list") return CONTROL_MARK + JSON.stringify({ t: message.t, old: message.old, vs: message.vs.slice(0, MAX_VOUCHES) });
  if (message.t === "loc") {
    return CONTROL_MARK + JSON.stringify({ t: "loc", lat: message.fix.lat, lng: message.fix.lng, accuracy: message.fix.accuracy });
  }
  if (message.t === "timer") {
    return CONTROL_MARK + JSON.stringify({ t: "timer", ms: message.ms, at: message.at });
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
  if (o.t === "timer") {
    const ms = validDisappearMs(o.ms);
    const at = typeof o.at === "number" && Number.isSafeInteger(o.at) && o.at >= 0 ? o.at : null;
    return ms === null || at === null ? null : { t: "timer", ms, at };
  }
  if (o.t === "suite") return validSuiteMessage(o);
  if (o.t === "vouch-grant") {
    const v = parseVouch(o.v);
    return v ? { t: "vouch-grant", v } : null;
  }
  if (o.t === "vouch-ask") return validDidKey(o.old) ? { t: "vouch-ask", old: o.old } : null;
  if (o.t === "vouch-list") {
    if (!validDidKey(o.old) || !Array.isArray(o.vs) || o.vs.length > MAX_VOUCHES) return null;
    const vs = o.vs.map(parseVouch);
    return vs.every((v): v is Vouch => v !== null) ? { t: "vouch-list", old: o.old, vs } : null;
  }
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
