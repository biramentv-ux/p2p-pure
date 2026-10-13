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

export interface ChatMessage {
  text: string;
  direction: Direction;
  timestamp: number;
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
      asBufferSource(new TextEncoder().encode(message.text)),
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
      text: new TextDecoder().decode(pt),
      direction: row.direction,
      timestamp: row.timestamp,
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
