/**
 * Group chat crypto and wire messages (mesh model).
 *
 * Every member has a verified pairwise link to every other member. Those links already
 * encrypt and authenticate everything, so this layer adds two things on top:
 *
 *  1. Group messages are encrypted once with the group key of their epoch and signed by
 *     the sender's Ed25519 identity key. A member cannot pass a message off as another
 *     member's, and a removed member cannot read messages from later epochs.
 *  2. Membership, name, cipher suite and keys come from the creator. Snapshots are
 *     signed by the creator and must be newer than the local version.
 *
 * Group keys travel only inside the pairwise encrypted links, and only to the members
 * who stay after a change.
 *
 * Also here: the record a device keeps between sessions (GroupSecrets: signed snapshot,
 * epoch keys, role, send counter). It is only ever written encrypted (groupStore.ts), and
 * restore() checks the creator's signature again before trusting it.
 *
 * Not here: the screens, the photo transfer, and the orchestration of the mesh (who
 * connects to whom). Those are the next layer.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { didKeyToPublicKey, publicKeyToDidKey } from "../identity/didKey";
import type { DidKey, Ed25519KeyPair } from "../identity/types";
import {
  aeadOpen,
  aeadSeal,
  suiteAadByte,
  suiteFromWireTag,
  suiteWireTag,
  type CipherSuite,
} from "../p2p/cipherSuite";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import { FRAME_MARK } from "../p2p/photo";
import {
  acceptSnapshot,
  addMember,
  MAX_GROUP_NAME_CHARS,
  applySuiteVote,
  approveSuite,
  createGroup,
  GroupError,
  isMember,
  proposeSuite,
  removeMember,
  setPhotoHash,
  suiteVoteComplete,
  type GroupMember,
  type GroupState,
  type SuiteVote,
} from "./groupModel";

export const GROUP_MARK = `${FRAME_MARK}G|`;
/**
 * A relayed invitation must fit in one pairwise message (SecureSession seals at most 4000
 * characters). Invitations are built to fit in a QR code, so this is generous.
 */
export const MAX_RELAY_INVITATION_CHARS = 3_400;
/**
 * Longest group message, in UTF-8 bytes. A sealed group message travels inside one pairwise
 * message, which holds at most 4000 characters; 2000 bytes (1000 Cyrillic letters) still fit.
 */
export const MAX_GROUP_TEXT_BYTES = 2_000;
/** Introductions by the admin are valid this long (the same as a QR invitation). */
export const INTRO_TTL_MS = 10 * 60 * 1000;
const HASH_HEX = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type GroupWire =
  | { t: "gsnap"; state: GroupState; sig: string }
  /** Admin to a candidate: the current signed state, so the candidate can link to the members. */
  | { t: "gpend"; state: GroupState; sig: string }
  /** Candidate to admin: "I am linked to these members", signed by the candidate. */
  | { t: "gjoin"; g: string; f: DidKey; linked: DidKey[]; sig: string }
  | { t: "gkey"; g: string; e: number; key: string }
  | { t: "gmsg"; g: string; e: number; f: DidKey; n: number; s: string; iv: string; ct: string; sig: string }
  | { t: "gvote"; op: "open"; g: string; id: string; suite: CipherSuite; sig: string }
  | { t: "gvote"; op: "approve"; g: string; id: string; f: DidKey; sig: string }
  /**
   * Admin to a member: "make a link to `peer`". Signed by the admin, so the member can show
   * the peer that a candidate was really introduced by the admin.
   */
  | { t: "gintro"; g: string; peer: DidKey; name: string; exp: number; sig: string }
  /**
   * A signed WebRTC invitation (offer or answer, see p2p/invitation.ts) on its way between two
   * members, through the admin. `from` is set by the admin when it forwards. The receiver
   * checks the invitation's own signature, so the admin can pass it on but cannot forge it.
   */
  | { t: "grelay"; g: string; to: DidKey; from?: DidKey; inv: string }
  /** "Please send me the group photo with this hash." Answered by anyone who has it. */
  | { t: "gphoto"; g: string; h: string };

export function encodeGroupWire(message: GroupWire): string {
  return GROUP_MARK + JSON.stringify(message);
}

export function isGroupWire(plaintext: string): boolean {
  return plaintext.startsWith(GROUP_MARK);
}

/** Parses untrusted text. Returns null for anything malformed. Signatures are checked later. */
export function decodeGroupWire(plaintext: string): GroupWire | null {
  if (!isGroupWire(plaintext)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext.slice(GROUP_MARK.length));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.t) {
    case "gsnap":
      return typeof o.sig === "string" && isGroupState(o.state) ? { t: "gsnap", state: o.state, sig: o.sig } : null;
    case "gpend":
      return typeof o.sig === "string" && isGroupState(o.state) ? { t: "gpend", state: o.state, sig: o.sig } : null;
    case "gjoin":
      if (
        typeof o.g === "string" && typeof o.f === "string" && typeof o.sig === "string" &&
        Array.isArray(o.linked) && o.linked.every((d) => typeof d === "string")
      ) {
        return { t: "gjoin", g: o.g, f: o.f, linked: o.linked as DidKey[], sig: o.sig };
      }
      return null;
    case "gkey":
      return typeof o.g === "string" && isEpoch(o.e) && typeof o.key === "string"
        ? { t: "gkey", g: o.g, e: o.e, key: o.key }
        : null;
    case "gmsg":
      if (
        typeof o.g === "string" && isEpoch(o.e) && typeof o.f === "string" && isEpoch(o.n) &&
        typeof o.s === "string" && typeof o.iv === "string" && typeof o.ct === "string" && typeof o.sig === "string"
      ) {
        return { t: "gmsg", g: o.g, e: o.e, f: o.f, n: o.n, s: o.s, iv: o.iv, ct: o.ct, sig: o.sig };
      }
      return null;
    case "gvote":
      if (typeof o.g !== "string" || typeof o.id !== "string" || typeof o.sig !== "string") return null;
      if (o.op === "open" && typeof o.suite === "string") {
        return { t: "gvote", op: "open", g: o.g, id: o.id, suite: o.suite as CipherSuite, sig: o.sig };
      }
      if (o.op === "approve" && typeof o.f === "string") {
        return { t: "gvote", op: "approve", g: o.g, id: o.id, f: o.f, sig: o.sig };
      }
      return null;
    case "gintro":
      if (
        typeof o.g === "string" && typeof o.peer === "string" && typeof o.name === "string" &&
        [...o.name].length <= MAX_GROUP_NAME_CHARS && Number.isSafeInteger(o.exp) && typeof o.sig === "string"
      ) {
        return { t: "gintro", g: o.g, peer: o.peer, name: o.name, exp: o.exp as number, sig: o.sig };
      }
      return null;
    case "grelay":
      if (
        typeof o.g === "string" && typeof o.to === "string" && typeof o.inv === "string" &&
        o.inv.length <= MAX_RELAY_INVITATION_CHARS && (o.from === undefined || typeof o.from === "string")
      ) {
        return o.from === undefined
          ? { t: "grelay", g: o.g, to: o.to, inv: o.inv }
          : { t: "grelay", g: o.g, to: o.to, from: o.from as string, inv: o.inv };
      }
      return null;
    case "gphoto":
      return typeof o.g === "string" && typeof o.h === "string" && HASH_HEX.test(o.h)
        ? { t: "gphoto", g: o.g, h: o.h }
        : null;
    default:
      return null;
  }
}

function isEpoch(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

function isGroupState(v: unknown): v is GroupState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.groupId === "string" &&
    typeof s.name === "string" &&
    typeof s.creatorDid === "string" &&
    (s.photoHash === null || typeof s.photoHash === "string") &&
    Array.isArray(s.members) &&
    s.members.every(
      (m) => typeof m === "object" && m !== null && typeof (m as GroupMember).did === "string" && typeof (m as GroupMember).name === "string",
    ) &&
    isEpoch(s.version) &&
    isEpoch(s.epoch) &&
    typeof s.suite === "string"
  );
}

/** The bytes the creator signs for a snapshot: the state with a fixed field order. */
function stateBytes(state: GroupState): Uint8Array {
  return enc.encode(
    JSON.stringify([
      "p2p-group/state/v1",
      state.groupId,
      state.name,
      state.creatorDid,
      state.photoHash,
      state.members.map((m) => [m.did, m.name]),
      state.version,
      state.epoch,
      state.suite,
    ]),
  );
}

function joinBytes(g: string, f: string, linked: DidKey[]): Uint8Array {
  return enc.encode(JSON.stringify(["p2p-group/join/v1", g, f, [...linked].sort()]));
}

/** Candidate side: signs "I am linked to these members". */
export function signJoinRequest(keys: Ed25519KeyPair, g: string, linked: DidKey[]): GroupWire & { t: "gjoin" } {
  const f = publicKeyToDidKey(keys.publicKey);
  return {
    t: "gjoin",
    g,
    f,
    linked: [...linked].sort(),
    sig: bytesToBase64Url(ed25519.sign(joinBytes(g, f, linked), keys.secretKey)),
  };
}

/** Admin side: checks that the join request is genuine. The caller checks the links. */
export function verifyJoinRequest(message: GroupWire & { t: "gjoin" }): boolean {
  return verifySig(message.sig, joinBytes(message.g, message.f, message.linked), message.f);
}

/** True if a signed state (creator-signed) is genuine. Used for gpend and gsnap. */
export function verifyStateSignature(message: { state: GroupState; sig: string }): boolean {
  return verifySig(message.sig, stateBytes(message.state), message.state.creatorDid);
}

function introBytes(g: string, peer: string, name: string, exp: number): Uint8Array {
  return enc.encode(JSON.stringify(["p2p-group/intro/v1", g, peer, name, exp]));
}

/** True if an introduction carries a valid signature by the group's admin and has not expired. */
export function verifyIntro(message: GroupWire & { t: "gintro" }, adminDid: DidKey, now = Date.now()): boolean {
  if (message.exp <= now || message.exp > now + 2 * INTRO_TTL_MS) return false;
  return verifySig(message.sig, introBytes(message.g, message.peer, message.name, message.exp), adminDid);
}

function voteBytes(g: string, id: string, suite: string): Uint8Array {
  return enc.encode(JSON.stringify(["p2p-group/vote/v1", g, id, suite]));
}

function approveBytes(g: string, id: string, did: string): Uint8Array {
  return enc.encode(JSON.stringify(["p2p-group/approve/v1", g, id, did]));
}

/** AAD for a group message: binds group, epoch, sender, counter and suite. */
function messageAad(g: string, e: number, f: string, n: number, suite: CipherSuite): Uint8Array {
  return enc.encode(`p2p-group/msg/v1|${g}|${e}|${f}|${n}|${suiteAadByte(suite)}`);
}

function signedBytes(aad: Uint8Array, iv: Uint8Array, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(aad.length + iv.length + ct.length);
  out.set(aad, 0);
  out.set(iv, aad.length);
  out.set(ct, aad.length + iv.length);
  return out;
}

function verifySig(sig: string, message: Uint8Array, did: DidKey): boolean {
  try {
    return ed25519.verify(base64UrlToBytes(sig), message, didKeyToPublicKey(did));
  } catch {
    return false;
  }
}

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * What a device keeps about its group between sessions. Contains the epoch keys, so it is
 * secret: groupStore.ts writes it only AES-GCM encrypted, never in plaintext.
 */
export interface GroupSecrets {
  v: 1;
  role: "admin" | "member";
  /** The creator-signed state. Checked again on restore. */
  snapshot: { state: GroupState; sig: string };
  /** Keys for the current epoch and newer (base64url). Older keys are not kept. */
  keys: Array<{ e: number; key: string }>;
  /** Next send counter. */
  counter: number;
}

/**
 * After a restore the counter jumps ahead by this much. A message sealed just before the
 * last save may not have been recorded, and reusing its counter would make the others drop
 * the next message as a replay.
 */
export const COUNTER_RESTORE_GAP = 64;

export class GroupChat {
  private state: GroupState;
  private readonly keys = new Map<number, Uint8Array>();
  private readonly seen = new Set<string>();
  private counter = 0;
  /** The creator's signature over the current state (member side; the admin signs fresh). */
  private sig: string | null = null;
  private vote: SuiteVote | null = null;
  private readonly me: { did: DidKey; keys: Ed25519KeyPair };

  private constructor(me: { did: DidKey; keys: Ed25519KeyPair }, state: GroupState) {
    this.me = me;
    this.state = state;
  }

  get snapshot(): GroupState {
    return this.state;
  }

  get isAdmin(): boolean {
    return this.me.did === this.state.creatorDid;
  }

  /** The key for an epoch, or undefined if this side does not have it yet. */
  keyFor(epoch: number): Uint8Array | undefined {
    return this.keys.get(epoch);
  }

  /** Creator side: a new group with the creator as the only member. */
  static create(keys: Ed25519KeyPair, groupId: string, name: string, creatorName: string): GroupChat {
    const did = didOf(keys);
    const state = createGroup({ groupId, name, creator: { did, name: creatorName } });
    const chat = new GroupChat({ did, keys }, state);
    chat.keys.set(0, randomKey());
    return chat;
  }

  /** Member side: builds the group from the creator's signed snapshot and the key for its epoch. */
  static join(keys: Ed25519KeyPair, snapshot: GroupWire & { t: "gsnap" }, key: { epoch: number; key: Uint8Array }): GroupChat {
    if (!verifySig(snapshot.sig, stateBytes(snapshot.state), snapshot.state.creatorDid)) {
      throw new GroupError("stale", "Подписът на групата не е валиден.");
    }
    const did = didOf(keys);
    if (!isMember(snapshot.state, did)) throw new GroupError("not-member", "Не сте участник в тази група.");
    const chat = new GroupChat({ did, keys }, snapshot.state);
    chat.sig = snapshot.sig;
    chat.keys.set(key.epoch, key.key);
    return chat;
  }

  /**
   * Rebuilds the group from a saved record. Refuses a record whose snapshot is not signed by
   * its creator, that does not list this device, or whose role or keys do not add up.
   */
  static restore(keys: Ed25519KeyPair, saved: GroupSecrets): GroupChat {
    const bad = (why: string) => new GroupError("stale", `Запазената група е повредена (${why}).`);
    if (saved?.v !== 1 || !isGroupState(saved.snapshot?.state) || typeof saved.snapshot.sig !== "string") {
      throw bad("формат");
    }
    const state = saved.snapshot.state;
    if (!verifySig(saved.snapshot.sig, stateBytes(state), state.creatorDid)) throw bad("подпис");
    const did = didOf(keys);
    if (!isMember(state, did)) throw new GroupError("not-member", "Не сте участник в тази група.");
    const admin = state.creatorDid === did;
    if (saved.role !== (admin ? "admin" : "member")) throw bad("роля");
    if (!isEpoch(saved.counter) || !Array.isArray(saved.keys)) throw bad("формат");
    const chat = new GroupChat({ did, keys }, state);
    chat.sig = saved.snapshot.sig;
    for (const k of saved.keys) {
      if (!isEpoch(k?.e) || typeof k.key !== "string" || k.e < state.epoch) throw bad("ключ");
      const raw = base64UrlToBytes(k.key);
      if (raw.length !== 32) throw bad("ключ");
      chat.keys.set(k.e, raw);
    }
    if (admin && !chat.keys.has(state.epoch)) throw bad("ключ");
    chat.counter = Math.min(0xffffffff, saved.counter + COUNTER_RESTORE_GAP);
    return chat;
  }

  /** The record to save. Secret: hand it only to the encrypted store. */
  exportSecrets(): GroupSecrets {
    const snapshot = this.isAdmin ? this.signedSnapshot() : { state: this.state, sig: this.sig ?? "" };
    const keys: Array<{ e: number; key: string }> = [];
    for (const [e, key] of this.keys) {
      if (e >= this.state.epoch) keys.push({ e, key: bytesToBase64Url(key) });
    }
    keys.sort((a, b) => a.e - b.e);
    return {
      v: 1,
      role: this.isAdmin ? "admin" : "member",
      snapshot: { state: snapshot.state, sig: snapshot.sig },
      keys,
      counter: this.counter,
    };
  }

  /** Admin: sets or clears the photo hash. Returns the new snapshot to send to everyone. */
  setPhoto(hash: string | null): GroupWire & { t: "gsnap" } {
    this.requireAdmin();
    this.state = setPhotoHash(this.state, this.me.did, hash);
    return this.signedSnapshot();
  }

  /** Admin: asks a member to link with `peer`, signed so the peer can check the request. */
  signIntro(peer: DidKey, name: string, now = Date.now()): GroupWire & { t: "gintro" } {
    this.requireAdmin();
    const exp = now + INTRO_TTL_MS;
    const g = this.state.groupId;
    return {
      t: "gintro",
      g,
      peer,
      name,
      exp,
      sig: bytesToBase64Url(ed25519.sign(introBytes(g, peer, name, exp), this.me.keys.secretKey)),
    };
  }

  /** Admin: the signed snapshot to send to every member. */
  signedSnapshot(): GroupWire & { t: "gsnap" } {
    if (!this.isAdmin) throw new GroupError("not-admin", "Само създателят подписва.");
    return { t: "gsnap", state: this.state, sig: bytesToBase64Url(ed25519.sign(stateBytes(this.state), this.me.keys.secretKey)) };
  }

  /** Admin: adds a member. Returns the new snapshot and the new key for the members who receive it. */
  admitMember(member: GroupMember): { snapshot: GroupWire & { t: "gsnap" }; keyFor: Map<DidKey, GroupWire> } {
    this.requireAdmin();
    this.state = addMember(this.state, this.me.did, member);
    return this.rotate();
  }

  /** Admin: removes a member. The removed member gets nothing new. */
  dropMember(did: DidKey): { snapshot: GroupWire & { t: "gsnap" }; keyFor: Map<DidKey, GroupWire> } {
    this.requireAdmin();
    this.state = removeMember(this.state, this.me.did, did);
    return this.rotate();
  }

  private requireAdmin(): void {
    if (!this.isAdmin) throw new GroupError("not-admin", "Само създателят може да прави това.");
  }

  /** New epoch key, sent to every current member except the admin. */
  private rotate(): { snapshot: GroupWire & { t: "gsnap" }; keyFor: Map<DidKey, GroupWire> } {
    const key = randomKey();
    this.keys.set(this.state.epoch, key);
    const keyFor = new Map<DidKey, GroupWire>();
    for (const m of this.state.members) {
      if (m.did === this.me.did) continue;
      keyFor.set(m.did, { t: "gkey", g: this.state.groupId, e: this.state.epoch, key: bytesToBase64Url(key) });
    }
    return { snapshot: this.signedSnapshot(), keyFor };
  }

  /** Member: a key for an epoch, from the admin over the pairwise link. */
  receiveKey(from: DidKey, message: GroupWire & { t: "gkey" }): void {
    if (from !== this.state.creatorDid) throw new GroupError("not-admin", "Ключ може да дойде само от създателя.");
    if (message.g !== this.state.groupId) throw new GroupError("stale", "Друга група.");
    const key = base64UrlToBytes(message.key);
    if (key.length !== 32) throw new GroupError("stale", "Невалиден ключ.");
    this.keys.set(message.e, key);
  }

  /** Member: accepts a newer snapshot from the creator. */
  receiveSnapshot(message: GroupWire & { t: "gsnap" }): void {
    if (!verifySig(message.sig, stateBytes(message.state), message.state.creatorDid)) {
      throw new GroupError("stale", "Подписът на групата не е валиден.");
    }
    this.state = acceptSnapshot(this.state, message.state);
    this.sig = message.sig;
  }

  /** Encrypts a group message with the current epoch key and the group suite. */
  async seal(text: string): Promise<GroupWire & { t: "gmsg" }> {
    if (enc.encode(text).length > MAX_GROUP_TEXT_BYTES) {
      throw new GroupError("too-long", "Съобщението е твърде дълго за групата.");
    }
    const key = this.keys.get(this.state.epoch);
    if (!key) throw new GroupError("stale", "Още няма групов ключ.");
    const suite = this.state.suite;
    const n = this.counter++;
    const e = this.state.epoch;
    const aad = messageAad(this.state.groupId, e, this.me.did, n, suite);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await aeadSeal(suite, key, iv, aad, enc.encode(text));
    const sig = ed25519.sign(signedBytes(aad, iv, ct), this.me.keys.secretKey);
    return {
      t: "gmsg",
      g: this.state.groupId,
      e,
      f: this.me.did,
      n,
      s: suiteWireTag(suite),
      iv: bytesToBase64Url(iv),
      ct: bytesToBase64Url(ct),
      sig: bytesToBase64Url(sig),
    };
  }

  /** Verifies, deduplicates and decrypts a group message. Throws if anything is wrong. */
  async open(message: GroupWire & { t: "gmsg" }): Promise<string> {
    if (message.g !== this.state.groupId) throw new GroupError("stale", "Друга група.");
    if (!isMember(this.state, message.f)) throw new GroupError("not-member", "Съобщението не е от участник.");
    const suite = suiteFromWireTag(message.s);
    if (!suite) throw new GroupError("stale", "Непознат метод.");
    const key = this.keys.get(message.e);
    if (!key) throw new GroupError("stale", "Липсва ключ за тази епоха.");
    const replayId = `${message.f}:${message.e}:${message.n}`;
    if (this.seen.has(replayId)) throw new GroupError("stale", "Повторно съобщение.");
    const aad = messageAad(message.g, message.e, message.f, message.n, suite);
    const iv = base64UrlToBytes(message.iv);
    const ct = base64UrlToBytes(message.ct);
    if (!verifySig(message.sig, signedBytes(aad, iv, ct), message.f)) {
      throw new GroupError("not-member", "Подписът на съобщението не е валиден.");
    }
    let pt: Uint8Array;
    try {
      pt = await aeadOpen(suite, key, iv, aad, ct);
    } catch {
      throw new GroupError("stale", "Съобщението не може да се разчете.");
    }
    this.seen.add(replayId);
    return dec.decode(pt);
  }

  /** Admin: opens a cipher-suite change. Every member other than the creator must approve. */
  openSuiteVote(id: string, suite: CipherSuite): GroupWire & { t: "gvote" } {
    this.requireAdmin();
    this.vote = proposeSuite(this.state, this.me.did, suite, id);
    return {
      t: "gvote",
      op: "open",
      g: this.state.groupId,
      id,
      suite,
      sig: bytesToBase64Url(ed25519.sign(voteBytes(this.state.groupId, id, suite), this.me.keys.secretKey)),
    };
  }

/** Member: a change opened by the admin. Returns the approval to send back. */
  approveSuiteVote(message: GroupWire & { t: "gvote"; op: "open" }): GroupWire & { t: "gvote" } {
    if (!verifySig(message.sig, voteBytes(message.g, message.id, message.suite), this.state.creatorDid)) {
      throw new GroupError("not-admin", "Подписът на предложението не е валиден.");
    }
    return {
      t: "gvote",
      op: "approve",
      g: this.state.groupId,
      id: message.id,
      f: this.me.did,
      sig: bytesToBase64Url(ed25519.sign(approveBytes(this.state.groupId, message.id, this.me.did), this.me.keys.secretKey)),
    };
  }

  /**
   * Admin: records a member's approval. When every member has approved, the suite
   * changes and a new signed snapshot is returned to send to everyone.
   */
  receiveApproval(message: GroupWire & { t: "gvote"; op: "approve" }): (GroupWire & { t: "gsnap" }) | null {
    this.requireAdmin();
    const vote = this.vote;
    if (!vote || vote.id !== message.id) return null;
    if (!isMember(this.state, message.f)) return null;
    if (!verifySig(message.sig, approveBytes(message.g, message.id, message.f), message.f)) return null;
    this.vote = approveSuite(this.state, vote, message.f);
    if (!suiteVoteComplete(this.state, this.vote)) return null;
    this.state = applySuiteVote(this.state, this.vote);
    this.vote = null;
    return this.signedSnapshot();
  }

  /** Current open vote, for the admin panel. */
  get openVote(): SuiteVote | null {
    return this.vote;
  }
}

/** True if an opened vote carries a valid signature by the group's admin. */
export function verifyVoteOpen(message: GroupWire & { t: "gvote"; op: "open" }, adminDid: DidKey): boolean {
  return verifySig(message.sig, voteBytes(message.g, message.id, message.suite), adminDid);
}

function didOf(keys: Ed25519KeyPair): DidKey {
  return publicKeyToDidKey(keys.publicKey);
}
