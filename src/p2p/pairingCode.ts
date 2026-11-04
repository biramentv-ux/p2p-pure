/**
 * Short pairing code: a 5-char room id (visible to the relay) plus 3 BIP39
 * words (the CPace password; the relay never sees them).
 *
 * Shown as "K7M2Q · lemon-rocket-bridge". The 3 words carry 33 bits, which is
 * weak on its own but safe under CPace: a relay can only make ONE online guess
 * per session, and offline guessing from the transcript is infeasible.
 */
import { randomBytes } from "@noble/hashes/utils.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const ROOM_ID_LENGTH = 5;
/** No 0/O/1/I/L/U: easy to read aloud and to type. */
export const ROOM_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_WORD_COUNT = 3;

export interface PairingCode {
  room: string;
  words: [string, string, string];
}

/** 3 words x 11 bits = 33 bits taken from 5 random bytes (40 bits, top 33 used). */
export function newPairingWords(
  random: (n: number) => Uint8Array = randomBytes,
): [string, string, string] {
  const bytes = random(5);
  if (bytes.length < 5) throw new Error("Not enough random bytes for the pairing words.");
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(bytes[i]);
  const words: string[] = [];
  for (let i = 0; i < PAIRING_WORD_COUNT; i++) {
    const shift = BigInt(40 - 11 * (i + 1));
    words.push(wordlist[Number((bits >> shift) & 0x7ffn)]);
  }
  return words as [string, string, string];
}

const ROOM_SEPARATORS = /[\s\-_.,·]/g;

export function normalizeRoomId(input: string): string | null {
  const room = input.toUpperCase().replace(ROOM_SEPARATORS, "");
  if (room.length !== ROOM_ID_LENGTH) return null;
  for (const ch of room) if (!ROOM_ID_ALPHABET.includes(ch)) return null;
  return room;
}

export function formatPairingCode(c: PairingCode): string {
  return `${c.room} · ${c.words.join("-")}`;
}

function resolveWord(token: string): string | null {
  if (!/^[a-z]+$/.test(token)) return null;
  if (token.length < 3) return null;
  if (wordlist.includes(token)) return token;
  if (token.length < 4) return null;
  const matches = wordlist.filter((w) => w.startsWith(token));
  return matches.length === 1 ? matches[0] : null;
}

export function parsePairingCode(input: string): PairingCode | null {
  const tokens = input
    .toLowerCase()
    .split(/[\s\-_.,·]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // The room is the first token (or, tolerantly, the first tokens that together make 5 chars).
  let room: string | null = null;
  let used = 0;
  let acc = "";
  for (const t of tokens) {
    acc += t;
    used++;
    if (acc.length >= ROOM_ID_LENGTH) break;
  }
  room = normalizeRoomId(acc);
  if (!room) return null;
  const rest = tokens.slice(used);
  if (rest.length !== PAIRING_WORD_COUNT) return null;
  const words: string[] = [];
  for (const t of rest) {
    const w = resolveWord(t);
    if (!w) return null;
    words.push(w);
  }
  return { room, words: words as [string, string, string] };
}

/** CPace password: the canonical words only; the room id is deliberately excluded. */
export function pairingPassword(c: PairingCode): Uint8Array {
  return new TextEncoder().encode(c.words.join("-"));
}
