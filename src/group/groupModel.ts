/**
 * Group chat state and rules. Pure: no network, no crypto keys, no storage.
 *
 * Roles: the creator is the only admin. Only the creator adds or removes members,
 * renames the group, sets the photo, or changes the cipher suite.
 *
 * Limits: at most MAX_GROUP_MEMBERS members, creator included. The mesh needs a live
 * link between every pair of members, so 9 is the cap.
 *
 * Versions: every change bumps `version`. Members accept a signed snapshot only if it is
 * newer than what they hold, so an old snapshot cannot undo a removal.
 *
 * Epochs: removing a member bumps `epoch`. Group messages use the key of their epoch, and
 * the new key is sent only to the members who stay (see groupChat.ts).
 *
 * Cipher-suite changes need every member to approve. The creator proposes, members
 * approve, and the change applies when the last approval arrives.
 */
import type { CipherSuite } from "../p2p/cipherSuite";
import { DEFAULT_CIPHER_SUITE, isCipherSuite } from "../p2p/cipherSuite";
import type { DidKey } from "../identity/types";

export const MAX_GROUP_MEMBERS = 9;
export const MAX_GROUP_NAME_CHARS = 40;
/** Hex SHA-256 of the group photo bytes. The photo itself is transferred separately. */
const HASH_HEX = /^[0-9a-f]{64}$/;

export interface GroupMember {
  did: DidKey;
  name: string;
}

export interface GroupState {
  groupId: string;
  name: string;
  /** Creator DID. The creator is the admin. */
  creatorDid: DidKey;
  /** SHA-256 (hex) of the group photo, or null. */
  photoHash: string | null;
  /** Creator first, then members in the order they joined. */
  members: GroupMember[];
  version: number;
  epoch: number;
  suite: CipherSuite;
}

export interface SuiteVote {
  id: string;
  suite: CipherSuite;
  /** DIDs that approved. The creator counts as approved by proposing. */
  approvals: DidKey[];
}

export type GroupErrorCode =
  | "not-admin"
  | "full"
  | "duplicate"
  | "unknown-member"
  | "cannot-remove-admin"
  | "bad-name"
  | "bad-hash"
  | "same-suite"
  | "vote-open"
  | "not-member"
  | "stale";

export class GroupError extends Error {
  readonly code: GroupErrorCode;
  constructor(code: GroupErrorCode, message: string) {
    super(message);
    this.name = "GroupError";
    this.code = code;
  }
}

export function normalizeGroupName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || [...trimmed].length > MAX_GROUP_NAME_CHARS) {
    throw new GroupError("bad-name", `Името трябва да е от 1 до ${MAX_GROUP_NAME_CHARS} символа.`);
  }
  return trimmed;
}

export function createGroup(input: { groupId: string; name: string; creator: GroupMember }): GroupState {
  return {
    groupId: input.groupId,
    name: normalizeGroupName(input.name),
    creatorDid: input.creator.did,
    photoHash: null,
    members: [{ did: input.creator.did, name: input.creator.name }],
    version: 1,
    epoch: 0,
    suite: DEFAULT_CIPHER_SUITE,
  };
}

export function isAdmin(state: GroupState, did: DidKey): boolean {
  return did === state.creatorDid;
}

export function isMember(state: GroupState, did: DidKey): boolean {
  return state.members.some((m) => m.did === did);
}

function requireAdmin(state: GroupState, actor: DidKey): void {
  if (!isAdmin(state, actor)) throw new GroupError("not-admin", "Само създателят може да прави това.");
}

export function addMember(state: GroupState, actor: DidKey, member: GroupMember): GroupState {
  requireAdmin(state, actor);
  if (isMember(state, member.did)) throw new GroupError("duplicate", "Този човек вече е в групата.");
  if (state.members.length >= MAX_GROUP_MEMBERS) {
    throw new GroupError("full", `Групата е пълна: най-много ${MAX_GROUP_MEMBERS} участника.`);
  }
  // Adding also bumps the epoch, so the newcomer gets a fresh key and cannot read earlier messages.
  return {
    ...state,
    members: [...state.members, { did: member.did, name: member.name }],
    version: state.version + 1,
    epoch: state.epoch + 1,
  };
}

/** Adding or removing a member bumps the epoch: the caller must rotate the group key. */
export function removeMember(state: GroupState, actor: DidKey, did: DidKey): GroupState {
  requireAdmin(state, actor);
  if (did === state.creatorDid) throw new GroupError("cannot-remove-admin", "Създателят не може да бъде махнат.");
  if (!isMember(state, did)) throw new GroupError("unknown-member", "Няма такъв участник.");
  return {
    ...state,
    members: state.members.filter((m) => m.did !== did),
    version: state.version + 1,
    epoch: state.epoch + 1,
  };
}

export function renameGroup(state: GroupState, actor: DidKey, name: string): GroupState {
  requireAdmin(state, actor);
  return { ...state, name: normalizeGroupName(name), version: state.version + 1 };
}

export function setPhotoHash(state: GroupState, actor: DidKey, hash: string | null): GroupState {
  requireAdmin(state, actor);
  if (hash !== null && !HASH_HEX.test(hash)) throw new GroupError("bad-hash", "Невалидна снимка.");
  return { ...state, photoHash: hash, version: state.version + 1 };
}

/** Starts a cipher-suite change. Every member other than the creator has to approve it. */
export function proposeSuite(state: GroupState, actor: DidKey, suite: CipherSuite, id: string): SuiteVote {
  requireAdmin(state, actor);
  if (!isCipherSuite(suite)) throw new GroupError("same-suite", "Непознат метод.");
  if (suite === state.suite) throw new GroupError("same-suite", "Този метод вече е активен.");
  return { id, suite, approvals: [state.creatorDid] };
}

export function approveSuite(state: GroupState, vote: SuiteVote, did: DidKey): SuiteVote {
  if (!isMember(state, did)) throw new GroupError("not-member", "Само участници могат да одобряват.");
  if (vote.approvals.includes(did)) return vote;
  return { ...vote, approvals: [...vote.approvals, did] };
}

export function suiteVoteComplete(state: GroupState, vote: SuiteVote): boolean {
  return state.members.every((m) => vote.approvals.includes(m.did));
}

/** Applies a completed vote. Throws if not every member has approved. */
export function applySuiteVote(state: GroupState, vote: SuiteVote): GroupState {
  if (!suiteVoteComplete(state, vote)) throw new GroupError("vote-open", "Не всички участници са одобрили.");
  return { ...state, suite: vote.suite, version: state.version + 1 };
}

/** A newer snapshot replaces the local state. Anything else is refused. */
export function acceptSnapshot(local: GroupState | null, incoming: GroupState): GroupState {
  if (local && incoming.groupId !== local.groupId) throw new GroupError("stale", "Друга група.");
  if (local && incoming.version <= local.version) throw new GroupError("stale", "Остаряла промяна.");
  if (local && incoming.epoch < local.epoch) throw new GroupError("stale", "Остарял ключ.");
  return incoming;
}
