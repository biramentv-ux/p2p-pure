/**
 * П7: key continuity without a server (docs/KEY-CONTINUITY.md). A light web of trust between
 * contacts, not key transparency: there is no log and nobody to run one.
 *
 * Someone loses their 12 words and starts again with a new identity (a new did:key). Their
 * contacts cannot tell a new key from an impostor. So the people who meet them again and compare
 * the 12 safety words with the new key can sign a statement:
 *
 *     "I, <by>, checked <new> myself; <new> is the same person as <old>, whom I had verified."
 *
 * The person with the new key keeps those statements and shows them to another old contact who
 * asks. That contact trusts a statement only when it is signed by someone in their own book whom
 * they verified themselves. The final choice stays with the person.
 *
 * Signed bytes: UTF-8 of "p2p-vouch/v1|same|<by>|<old>|<new>|<at>", Ed25519 with the identity key.
 * Everything that comes from another person is parsed strictly (exact keys and types) and checked.
 */
import { didKeyToPublicKey } from "../identity/didKey";
import { sign, verify } from "../identity/keypair";
import type { Ed25519KeyPair } from "../identity/types";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import { validDidKey } from "../intro/introMessages";

export interface Vouch {
  /** Who signs (the witness). */
  by: string;
  /** The key the person had before. */
  old: string;
  /** The key they have now. */
  new: string;
  /** Unix ms when it was signed. */
  at: number;
  /** Ed25519 signature, base64url. */
  sig: string;
}

/** A person shows at most this many statements at once. */
export const MAX_VOUCHES = 20;
/** A statement from the future by more than this much is refused (clocks differ a little). */
const FUTURE_SLACK_MS = 10 * 60 * 1000;

const enc = new TextEncoder();

export function vouchBytes(v: Pick<Vouch, "by" | "old" | "new" | "at">): Uint8Array {
  return enc.encode(`p2p-vouch/v1|same|${v.by}|${v.old}|${v.new}|${v.at}`);
}

/** Signs "<newDid> is the same person as <oldDid>" with my identity key. */
export function signVouch(me: { did: string; keyPair: Ed25519KeyPair }, oldDid: string, newDid: string, at = Date.now()): Vouch {
  if (!validDidKey(oldDid) || !validDidKey(newDid) || oldDid === newDid) throw new Error("bad vouch");
  if (oldDid === me.did || newDid === me.did) throw new Error("bad vouch");
  const body = { by: me.did, old: oldDid, new: newDid, at };
  return { ...body, sig: bytesToBase64Url(sign(vouchBytes(body), me.keyPair)) };
}

/** The statement if it is well formed, else null. Does not check the signature. */
export function parseVouch(raw: unknown): Vouch | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "at,by,new,old,sig") return null;
  if (!validDidKey(o.by) || !validDidKey(o.old) || !validDidKey(o.new)) return null;
  if (o.old === o.new || o.by === o.old || o.by === o.new) return null;
  if (typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at <= 0) return null;
  if (typeof o.sig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(o.sig)) return null;
  return { by: o.by, old: o.old, new: o.new, at: o.at, sig: o.sig };
}

export function vouchSignatureOk(v: Vouch, now = Date.now()): boolean {
  if (v.at > now + FUTURE_SLACK_MS) return false;
  try {
    return verify(base64UrlToBytes(v.sig), vouchBytes(v), didKeyToPublicKey(v.by));
  } catch {
    return false;
  }
}

/** Who I know: enough of a contact for judging a statement. */
export interface Witness {
  did: string;
  name: string;
  verified: boolean;
}

export interface VouchVerdict {
  /** My own verified contacts who signed that `newDid` is `oldDid`. */
  confirmedBy: Witness[];
  /** Statements I cannot use: signed by people I do not know or did not verify, or bad ones. */
  ignored: number;
}

/**
 * Judges the statements a person showed me. Only statements about exactly this old and new key,
 * with a valid signature, by someone in my book whom I verified myself, count. One per witness.
 */
export function judgeVouches(statements: readonly Vouch[], oldDid: string, newDid: string, lookup: (did: string) => Witness | null, now = Date.now()): VouchVerdict {
  const confirmed = new Map<string, Witness>();
  let ignored = 0;
  for (const v of statements.slice(0, MAX_VOUCHES)) {
    const w = v.old === oldDid && v.new === newDid && vouchSignatureOk(v, now) ? lookup(v.by) : null;
    if (w && w.verified && w.did !== oldDid && w.did !== newDid) confirmed.set(w.did, w);
    else ignored++;
  }
  ignored += Math.max(0, statements.length - MAX_VOUCHES);
  return { confirmedBy: [...confirmed.values()], ignored };
}
