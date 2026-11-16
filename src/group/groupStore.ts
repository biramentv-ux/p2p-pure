/**
 * Group state and group history, encrypted at rest.
 *
 * Same scheme as the one-to-one history (src/history/messageStore.ts): AES-256-GCM through
 * WebCrypto with the history key, which is derived in memory from the unlocked identity.
 * Nothing is stored in plaintext: not the epoch keys, not the member list, not the messages.
 * Only the random group id, a timestamp, the record ids and an owner tag are visible in
 * IndexedDB.
 *
 * The owner tag is SHA-256 of a label and the history key, cut to 8 bytes. It reveals
 * nothing about the key; it only keeps records of two identities apart when they share one
 * database (a reset identity on the same browser, or the tests).
 *
 * The associated data names the record kind, the owner and the group, so a record cannot be
 * moved to another group or passed off as a one-to-one message (those use "<did>|<dir>|<time>").
 *
 * What a device holds after a reload: the creator-signed snapshot, the key of the current
 * epoch (and of a newer one, if it already arrived), its role, its send counter, the group
 * photo if it was verified, and the history. The links themselves are not stored: WebRTC
 * links do not survive a reload and have to be made again.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { asBufferSource } from "../identity/bufferUtils";
import { STORE_GROUP_MESSAGES, STORE_GROUPS, withStore } from "../db/database";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import type { GroupSecrets } from "./groupChat";
import { validDisappearMs, type TimerSetting } from "../history/disappearing";

const enc = new TextEncoder();
const dec = new TextDecoder();
const OWNER_LABEL = enc.encode("p2p-group/store/owner/v1");
const PHOTO_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
/** At most this many messages are loaded when the group screen opens. */
export const GROUP_HISTORY_LIMIT = 500;

export interface StoredGroup {
  secrets: GroupSecrets;
  /** The group photo as a data URL, only if its bytes match the signed hash. */
  photo: string | null;
  /** Disappearing messages in this group (Н7): the agreed setting, or null if never set. */
  timer: TimerSetting | null;
  updatedAt: number;
}

export interface GroupHistoryEntry {
  /** Sender DID. */
  from: string;
  text: string;
  at: number;
  /** Disappearing message: deleted from the device after this time. */
  expiresAt?: number;
  /** The kept file of an expiring file message, so the sweep can delete it too. */
  fileId?: string;
}

interface GroupRow {
  /** owner|groupId */
  slot: string;
  groupId: string;
  updatedAt: number;
  iv: string;
  ct: string;
}

interface GroupMessageRow {
  id: string;
  /** owner|groupId */
  slot: string;
  at: number;
  iv: string;
  ct: string;
  /** In the clear so the sweep can delete it while locked (messageStore.purgeExpired). In the AAD. */
  expiresAt?: number;
  fileId?: string;
}

function ownerTag(historyKey: Uint8Array): string {
  const input = new Uint8Array(OWNER_LABEL.length + historyKey.length);
  input.set(OWNER_LABEL, 0);
  input.set(historyKey, OWNER_LABEL.length);
  return bytesToHex(sha256(input).slice(0, 8));
}

function slotOf(historyKey: Uint8Array, groupId: string): string {
  return `${ownerTag(historyKey)}|${groupId}`;
}

function stateAad(slot: string): Uint8Array {
  return enc.encode(`p2p-group/store/state/v1|${slot}`);
}

function messageAad(slot: string, id: string, at: number, expiresAt?: number): Uint8Array {
  // Rows without a timer keep the old AAD, so earlier history still opens.
  const tail = expiresAt === undefined ? "" : `|exp:${expiresAt}`;
  return enc.encode(`p2p-group/store/msg/v1|${slot}|${id}|${at}${tail}`);
}

function validExpiry(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(raw), "AES-GCM", false, [usage]);
}

async function seal(key: Uint8Array, aad: Uint8Array, plaintext: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv), additionalData: asBufferSource(aad) },
    await importKey(key, "encrypt"),
    asBufferSource(enc.encode(plaintext)),
  );
  return { iv: bytesToBase64Url(iv), ct: bytesToBase64Url(new Uint8Array(ct)) };
}

/** Returns null when the record does not authenticate (wrong key, moved or changed). */
async function open(key: CryptoKey, aad: Uint8Array, iv: string, ct: string): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(base64UrlToBytes(iv)), additionalData: asBufferSource(aad) },
      key,
      asBufferSource(base64UrlToBytes(ct)),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** SHA-256 (hex) of the bytes inside a photo data URL, or null if it is not one. */
export function photoUrlHash(url: string): string | null {
  const m = PHOTO_URL_RE.exec(url);
  if (!m) return null;
  try {
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytesToHex(sha256(bytes));
  } catch {
    return null;
  }
}

/** Saves (replaces) the group record. `secrets` holds keys: it is encrypted before the write. */
export async function saveGroup(
  historyKey: Uint8Array,
  secrets: GroupSecrets,
  photo: string | null,
  timer: TimerSetting | null = null,
): Promise<void> {
  const groupId = secrets.snapshot.state.groupId;
  const slot = slotOf(historyKey, groupId);
  const { iv, ct } = await seal(historyKey, stateAad(slot), JSON.stringify({ secrets, photo, ...(timer ? { timer } : {}) }));
  const row: GroupRow = { slot, groupId, updatedAt: Date.now(), iv, ct };
  await withStore(STORE_GROUPS, "readwrite", (s) => {
    s.put(row);
  });
}

/** Every group this key can open, newest first. Records that do not authenticate are skipped. */
export async function loadGroups(historyKey: Uint8Array): Promise<StoredGroup[]> {
  const owner = ownerTag(historyKey);
  const rows = ((await withStore<GroupRow[]>(STORE_GROUPS, "readonly", (s) => s.getAll())) ?? []).filter(
    (r) => r.slot === `${owner}|${r.groupId}`,
  );
  const key = await importKey(historyKey, "decrypt");
  const out: StoredGroup[] = [];
  for (const row of rows) {
    const text = await open(key, stateAad(row.slot), row.iv, row.ct);
    if (text === null) continue;
    let parsed: { secrets?: GroupSecrets; photo?: unknown; timer?: { ms?: unknown; at?: unknown } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      continue;
    }
    const secrets = parsed.secrets;
    if (!secrets || secrets.snapshot?.state?.groupId !== row.groupId) continue;
    // The photo is kept only while it still matches the signed hash.
    const hash = secrets.snapshot.state.photoHash;
    const photo = typeof parsed.photo === "string" && hash !== null && photoUrlHash(parsed.photo) === hash ? parsed.photo : null;
    const ms = validDisappearMs(parsed.timer?.ms);
    const at = parsed.timer?.at;
    const timer = ms !== null && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? { ms, at } : null;
    out.push({ secrets, photo, timer, updatedAt: row.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Deletes this identity's record of the group and its whole history. */
export async function deleteGroup(historyKey: Uint8Array, groupId: string): Promise<void> {
  const slot = slotOf(historyKey, groupId);
  await withStore(STORE_GROUPS, "readwrite", (s) => {
    s.delete(slot);
  });
  const keys =
    (await withStore<IDBValidKey[]>(STORE_GROUP_MESSAGES, "readonly", (s) =>
      s.index("bySlot").getAllKeys(IDBKeyRange.only(slot)),
    )) ?? [];
  if (keys.length === 0) return;
  await withStore(STORE_GROUP_MESSAGES, "readwrite", (s) => {
    for (const k of keys) s.delete(k);
  });
}

export async function appendGroupMessage(historyKey: Uint8Array, groupId: string, entry: GroupHistoryEntry): Promise<void> {
  const slot = slotOf(historyKey, groupId);
  const id = `${slot}|${entry.at}|${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const expiresAt = validExpiry(entry.expiresAt);
  const { iv, ct } = await seal(historyKey, messageAad(slot, id, entry.at, expiresAt), JSON.stringify({ f: entry.from, x: entry.text }));
  const row: GroupMessageRow = {
    id,
    slot,
    at: entry.at,
    iv,
    ct,
    ...(expiresAt !== undefined ? { expiresAt, ...(entry.fileId ? { fileId: entry.fileId } : {}) } : {}),
  };
  await withStore(STORE_GROUP_MESSAGES, "readwrite", (s) => {
    s.put(row);
  });
}

/** The newest `limit` messages of a group, oldest first. Rows that do not authenticate are skipped. */
export async function loadGroupHistory(
  historyKey: Uint8Array,
  groupId: string,
  limit = GROUP_HISTORY_LIMIT,
  now = Date.now(),
): Promise<GroupHistoryEntry[]> {
  const slot = slotOf(historyKey, groupId);
  const rows =
    (await withStore<GroupMessageRow[]>(STORE_GROUP_MESSAGES, "readonly", (s) =>
      s.index("bySlot").getAll(IDBKeyRange.only(slot)),
    )) ?? [];
  rows.sort((a, b) => a.at - b.at);
  const key = await importKey(historyKey, "decrypt");
  const out: GroupHistoryEntry[] = [];
  for (const row of rows.slice(-limit)) {
    const expiresAt = validExpiry(row.expiresAt);
    if (expiresAt !== undefined && expiresAt <= now) continue; // the sweep deletes it
    const text = await open(key, messageAad(row.slot, row.id, row.at, expiresAt), row.iv, row.ct);
    if (text === null) continue;
    try {
      const o = JSON.parse(text) as { f?: unknown; x?: unknown };
      if (typeof o.f === "string" && typeof o.x === "string") out.push({ from: o.f, text: o.x, at: row.at, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    } catch {
      /* skip */
    }
  }
  return out;
}
