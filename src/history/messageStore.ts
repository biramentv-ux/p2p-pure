/**
 * Local message history. Every record is AES-256-GCM encrypted before it is
 * written to IndexedDB. The key is derived in memory from the unlocked
 * identity, so the database never holds plaintext messages or the key.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { asBufferSource } from "../identity/bufferUtils";
import type { UnlockedIdentity } from "../identity/types";
import { STORE_MESSAGES, withStore } from "../db/database";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";

const HISTORY_INFO = new TextEncoder().encode("p2p-messenger/history-key/v1");

export type Direction = "in" | "out";

/** A location the person chose to share. Coordinates in degrees, accuracy in metres. */
export interface LocationFix {
  lat: number;
  lng: number;
  accuracy: number;
}

/** A file sent or received in the chat. The bytes are in fileStore.ts when `stored` is true. */
export interface FileCard {
  id: string;
  name: string;
  size: number;
  mime: string;
  stored: boolean;
}

export interface ChatMessage {
  text: string;
  /** A file card. When set, `text` is empty. */
  file?: FileCard;
  /** Photo as a data URL (jpeg, png or webp). When set, `text` is empty. */
  image?: string;
  /** Shared location. When set, `text` is empty. */
  location?: LocationFix;
  direction: Direction;
  timestamp: number;
}

const IMAGE_MARK = "\u0001I|";
const LOCATION_MARK = "\u0001G|";
const FILE_MARK = "\u0001F|";
const FILE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Returns the card if every field is sane, otherwise null. */
export function validFileCard(c: FileCard): FileCard | null {
  const ok =
    c !== null &&
    typeof c === "object" &&
    typeof c.id === "string" &&
    FILE_ID_RE.test(c.id) &&
    typeof c.name === "string" &&
    c.name.length > 0 &&
    c.name.length <= 200 &&
    Number.isInteger(c.size) &&
    c.size > 0 &&
    typeof c.mime === "string" &&
    c.mime.length <= 100 &&
    typeof c.stored === "boolean";
  return ok ? { id: c.id, name: c.name, size: c.size, mime: c.mime, stored: c.stored } : null;
}
const IMAGE_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Returns the fix if the values are real coordinates, otherwise null. */
export function validLocation(fix: LocationFix): LocationFix | null {
  const ok =
    Number.isFinite(fix.lat) &&
    Number.isFinite(fix.lng) &&
    Number.isFinite(fix.accuracy) &&
    Math.abs(fix.lat) <= 90 &&
    Math.abs(fix.lng) <= 180 &&
    fix.accuracy >= 0 &&
    fix.accuracy <= 100_000;
  return ok ? { lat: fix.lat, lng: fix.lng, accuracy: Math.round(fix.accuracy) } : null;
}

/** Text, photos and locations share one encrypted field; the marker tells them apart. */
function toPayload(m: ChatMessage): string {
  if (m.file) return FILE_MARK + JSON.stringify(m.file);
  if (m.location) return LOCATION_MARK + JSON.stringify(m.location);
  return m.image ? IMAGE_MARK + m.image : m.text;
}

function fromPayload(payload: string): Pick<ChatMessage, "text" | "image" | "location" | "file"> {
  if (payload.startsWith(FILE_MARK)) {
    try {
      const card = validFileCard(JSON.parse(payload.slice(FILE_MARK.length)) as FileCard);
      if (card) return { text: "", file: card };
    } catch {
      /* fall through */
    }
    return { text: "" };
  }
  if (payload.startsWith(LOCATION_MARK)) {
    try {
      const fix = validLocation(JSON.parse(payload.slice(LOCATION_MARK.length)) as LocationFix);
      if (fix) return { text: "", location: fix };
    } catch {
      /* fall through */
    }
    return { text: "" };
  }
  if (payload.startsWith(IMAGE_MARK)) {
    const url = payload.slice(IMAGE_MARK.length);
    if (IMAGE_URL_RE.test(url)) return { text: "", image: url };
    return { text: "" };
  }
  return { text: payload };
}

interface StoredMessage {
  id: string;
  peerDid: string;
  direction: Direction;
  timestamp: number;
  iv: string;
  ct: string;
}

/** Derives the history encryption key from the identity seed. */
export function deriveHistoryKey(identity: UnlockedIdentity): Uint8Array {
  return hkdf(sha256, identity.keyPair.secretKey, undefined, HISTORY_INFO, 32);
}

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(raw), "AES-GCM", false, [usage]);
}

function aadFor(peerDid: string, direction: Direction, timestamp: number): Uint8Array {
  return new TextEncoder().encode(`${peerDid}|${direction}|${timestamp}`);
}

export async function appendMessage(
  historyKey: Uint8Array,
  peerDid: string,
  message: ChatMessage,
): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(historyKey, "encrypt");
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(iv),
        additionalData: asBufferSource(aadFor(peerDid, message.direction, message.timestamp)),
      },
      key,
      asBufferSource(new TextEncoder().encode(toPayload(message))),
    ),
  );
  const random = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(9)));
  const record: StoredMessage = {
    id: `${peerDid}|${message.timestamp}|${random}`,
    peerDid,
    direction: message.direction,
    timestamp: message.timestamp,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(ct),
  };
  await withStore(STORE_MESSAGES, "readwrite", (s) => {
    s.put(record);
  });
}

export async function loadHistory(historyKey: Uint8Array, peerDid: string): Promise<ChatMessage[]> {
  const rows = await withStore<StoredMessage[]>(STORE_MESSAGES, "readonly", (s) =>
    s.index("byPeer").getAll(IDBKeyRange.only(peerDid)),
  );
  const key = await importKey(historyKey, "decrypt");
  const out: ChatMessage[] = [];
  for (const row of rows ?? []) {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(base64UrlToBytes(row.iv)),
        additionalData: asBufferSource(aadFor(row.peerDid, row.direction, row.timestamp)),
      },
      key,
      asBufferSource(base64UrlToBytes(row.ct)),
    );
    out.push({
      ...fromPayload(new TextDecoder().decode(pt)),
      direction: row.direction,
      timestamp: row.timestamp,
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/** Deletes every stored message with this contact. Returns how many were removed. */
export async function deleteHistory(peerDid: string): Promise<number> {
  const keys =
    (await withStore<IDBValidKey[]>(STORE_MESSAGES, "readonly", (s) =>
      s.index("byPeer").getAllKeys(IDBKeyRange.only(peerDid)),
    )) ?? [];
  if (keys.length === 0) return 0;
  await withStore(STORE_MESSAGES, "readwrite", (s) => {
    for (const key of keys) s.delete(key);
  });
  return keys.length;
}
