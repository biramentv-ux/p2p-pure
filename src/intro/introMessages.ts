/**
 * Introduction messages (M8, docs/INTRODUCTIONS.md). They travel only inside an existing
 * encrypted pairwise session, as control messages (p2p/control.ts). Everything here comes
 * from another person, so it is parsed strictly: exact keys, exact types, bounded lengths,
 * a real Ed25519 did:key. Anything else is dropped (null).
 *
 *  intro-request  A -> C    "introduce me to someone you know" (no names, no lists)
 *  intro-offer    C -> A/B  "C wants to introduce you to <did, name>"; req = the request it answers
 *  intro-accept   A/B -> C  accepted
 *  intro-decline  any       declined (an offer, or a request)
 *  intro-ready    C -> A/B  both accepted; `offer` says which side starts the WebRTC offer
 *  intro-relay    A <-> C <-> B  one signed WebRTC invitation (p2p/invitation.ts)
 *  intro-cancel   C -> A/B  the introduction is over (declined, expired, cancelled)
 */
import { didKeyToPublicKey, publicKeyToDidKey } from "../identity/didKey";
import { INVITATION_PREFIX } from "../p2p/invitation";

/** Introductions, invitations and requests expire after this long. */
export const INTRO_TTL_MS = 10 * 60 * 1000;
/** Longest display name an introduction may carry. */
export const MAX_INTRO_NAME_CHARS = 64;
/** Same bound as a group relay (group/groupChat.ts MAX_RELAY_INVITATION_CHARS). */
export const MAX_INTRO_INVITATION_CHARS = 3_400;
/** How many invitations C forwards for one introduction (offer + answer, with room for a retry). */
export const MAX_INTRO_RELAYS = 6;

export type IntroMessage =
  | { t: "intro-request"; id: string }
  | { t: "intro-offer"; id: string; did: string; name: string; exp: number; req?: string }
  | { t: "intro-accept"; id: string }
  | { t: "intro-decline"; id: string }
  | { t: "intro-ready"; id: string; offer: boolean }
  | { t: "intro-relay"; id: string; inv: string }
  | { t: "intro-cancel"; id: string };

export type IntroType = IntroMessage["t"];

const INTRO_TYPES: readonly IntroType[] = [
  "intro-request",
  "intro-offer",
  "intro-accept",
  "intro-decline",
  "intro-ready",
  "intro-relay",
  "intro-cancel",
];

const ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const DID_RE = /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
/** Control characters and bidirectional overrides: never in a name shown to the user. */
// eslint-disable-next-line no-control-regex
const BAD_NAME_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;
const INV_RE = /^[A-Za-z0-9_-]+$/;

export function isIntroType(t: unknown): t is IntroType {
  return typeof t === "string" && (INTRO_TYPES as readonly string[]).includes(t);
}

export function validIntroId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

/** A did:key that decodes to a 32-byte Ed25519 key and encodes back to itself. */
export function validDidKey(did: unknown): did is string {
  if (typeof did !== "string" || !DID_RE.test(did)) return false;
  try {
    const pk = didKeyToPublicKey(did);
    return pk.length === 32 && publicKeyToDidKey(pk) === did;
  } catch {
    return false;
  }
}

export function validIntroName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  return trimmed.length >= 1 && name.length <= MAX_INTRO_NAME_CHARS && trimmed === name && !BAD_NAME_RE.test(name);
}

export function validRelayInvitation(inv: unknown): inv is string {
  return (
    typeof inv === "string" &&
    inv.length <= MAX_INTRO_INVITATION_CHARS &&
    inv.startsWith(INVITATION_PREFIX) &&
    INV_RE.test(inv.slice(INVITATION_PREFIX.length))
  );
}

/** A name safe to put in an introduction: trimmed, cut to the limit, control characters removed. */
export function cleanIntroName(name: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  const cut = cleaned.slice(0, MAX_INTRO_NAME_CHARS).trim();
  return cut || fallback;
}

/** New random id: 16 bytes, base64url (22 characters). */
export function newIntroId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hasExactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  if (!required.every((k) => k in o)) return false;
  return keys.every((k) => required.includes(k) || optional.includes(k));
}

/** Validates an already parsed object. Returns the message, or null for anything off. */
export function validIntroMessage(raw: unknown): IntroMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isIntroType(o.t) || !validIntroId(o.id)) return null;
  const id = o.id;
  switch (o.t) {
    case "intro-request":
    case "intro-accept":
    case "intro-decline":
    case "intro-cancel":
      return hasExactKeys(o, ["t", "id"]) ? { t: o.t, id } : null;
    case "intro-ready":
      if (!hasExactKeys(o, ["t", "id", "offer"]) || typeof o.offer !== "boolean") return null;
      return { t: "intro-ready", id, offer: o.offer };
    case "intro-relay":
      if (!hasExactKeys(o, ["t", "id", "inv"]) || !validRelayInvitation(o.inv)) return null;
      return { t: "intro-relay", id, inv: o.inv };
    case "intro-offer": {
      if (!hasExactKeys(o, ["t", "id", "did", "name", "exp"], ["req"])) return null;
      if (!validDidKey(o.did) || !validIntroName(o.name)) return null;
      if (typeof o.exp !== "number" || !Number.isSafeInteger(o.exp) || o.exp <= 0) return null;
      if (o.req !== undefined && !validIntroId(o.req)) return null;
      const m: IntroMessage = { t: "intro-offer", id, did: o.did, name: o.name, exp: o.exp };
      if (o.req !== undefined) m.req = o.req as string;
      return m;
    }
    default:
      return null;
  }
}

/** The JSON body (without the control mark). Fields in a fixed order. */
export function introToJson(m: IntroMessage): string {
  switch (m.t) {
    case "intro-offer":
      return JSON.stringify(
        m.req === undefined
          ? { t: m.t, id: m.id, did: m.did, name: m.name, exp: m.exp }
          : { t: m.t, id: m.id, did: m.did, name: m.name, exp: m.exp, req: m.req },
      );
    case "intro-ready":
      return JSON.stringify({ t: m.t, id: m.id, offer: m.offer });
    case "intro-relay":
      return JSON.stringify({ t: m.t, id: m.id, inv: m.inv });
    default:
      return JSON.stringify({ t: m.t, id: m.id });
  }
}
