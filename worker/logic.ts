// Pure signaling logic for the Telegram forwarding Worker.
// No storage, no I/O: everything here is testable in isolation.
//
// Model: a user's "code" is their own Telegram chat id, base64url-encoded.
// The Worker stores nothing; the code itself carries the routing target.
// Invitations are forwarded verbatim. Their integrity is checked by the
// client (Ed25519 signature inside the invitation), never by the Worker.

export const INVITATION_PREFIX = "p2p1:";
/** Telegram's sendMessage limit is 4096 characters; keep headroom. */
export const MAX_INVITATION_CHARS = 3000;

const INVITATION_RE = /^p2p1:[A-Za-z0-9_-]+$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Encodes a Telegram chat id as a shareable routing code. */
export function encodeChatCode(chatId: number): string {
  return bytesToBase64Url(new TextEncoder().encode(String(chatId)));
}

/** Returns the chat id for a routing code, or null if the code is not valid. */
export function decodeChatCode(code: string): number | null {
  const bytes = base64UrlToBytes(code.trim());
  if (!bytes || bytes.length === 0 || bytes.length > 20) return null;
  const text = new TextDecoder().decode(bytes);
  if (!/^-?\d{1,19}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

export function isValidInvitation(text: string): boolean {
  return text.length <= MAX_INVITATION_CHARS && INVITATION_RE.test(text);
}

export type Command =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "send"; targetChatId: number; invitation: string }
  | { kind: "error"; reason: string }
  | { kind: "ignore" };

/**
 * Parses one incoming Telegram text message.
 *   /start                      -> show the sender's own code
 *   /help                       -> show instructions
 *   /send <code>\n<invitation>  -> forward the invitation to the code's chat
 */
export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  if (trimmed === "/start" || trimmed.startsWith("/start ")) return { kind: "start" };
  if (trimmed === "/help" || trimmed.startsWith("/help ")) return { kind: "help" };
  if (!trimmed.startsWith("/send")) return { kind: "ignore" };

  const rest = trimmed.slice("/send".length).trim();
  const newline = rest.indexOf("\n");
  if (newline < 0) {
    return { kind: "error", reason: "Формат: /send <код>, после нов ред постави поканата." };
  }
  const code = rest.slice(0, newline).trim();
  const invitation = rest.slice(newline + 1).trim();

  const targetChatId = decodeChatCode(code);
  if (targetChatId === null) {
    return { kind: "error", reason: "Невалиден код на получателя." };
  }
  if (!isValidInvitation(invitation)) {
    return { kind: "error", reason: "Поканата е невалидна или прекалено дълга." };
  }
  return { kind: "send", targetChatId, invitation };
}

/** Constant-time comparison of the Telegram webhook secret header. */
export function isAuthorizedWebhook(header: string | null, expected: string): boolean {
  if (!header || !expected) return false;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Prefix of the inline button's callback data. Telegram allows up to 64 bytes. */
export const DELETE_CALLBACK_PREFIX = "d:";
/** Time after which an unclicked delivery message is deleted anyway. */
export const DELIVERY_TTL_MS = 10 * 60 * 1000;

/** Random 128-bit token, base64url. It is never part of the invitation itself. */
export function newDeliveryToken(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return bytesToBase64Url(random(16));
}

/** Returns the token from callback data, or null if the data is not ours. */
export function parseDeleteCallback(data: string | undefined): string | null {
  if (!data || !data.startsWith(DELETE_CALLBACK_PREFIX)) return null;
  const token = data.slice(DELETE_CALLBACK_PREFIX.length);
  return /^[A-Za-z0-9_-]{22}$/.test(token) ? token : null;
}

/** KV key for a pending delivery. */
export function deliveryKey(token: string): string {
  return `d:${token}`;
}

/**
 * Short invitation codes: a 10-character code (~49 bits) maps to one signed
 * invitation for INVITE_TTL_SEC seconds, and the first fetch consumes it.
 * The alphabet drops 0, O, 1, I, L and U so codes read aloud or copied by hand
 * are unambiguous.
 */
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 10;
/** KV minimum expiration is 60 s; invitations live as long as the app's own TTL. */
export const INVITE_TTL_SEC = 600;

/** Random short code. Rejection sampling keeps every character equally likely. */
export function newInviteCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % INVITE_CODE_ALPHABET.length); // 240: bytes below this are unbiased
  let out = "";
  while (out.length < INVITE_CODE_LENGTH) {
    for (const b of random(INVITE_CODE_LENGTH)) {
      if (b < limit && out.length < INVITE_CODE_LENGTH) out += INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Accepts what a person types: any case, spaces or dashes. Returns null if invalid. */
export function normalizeInviteCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of code) if (!INVITE_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** KV key for a pending short invitation. */
export function inviteKey(code: string): string {
  return `i:${code}`;
}

/**
 * Demo WebSocket rooms. New clients get a 5-character room id (~24 bits); the
 * PAKE words the clients add on top never reach the Worker. Older clients still
 * use 10-character ids, so both lengths are accepted when joining a room.
 */
export const ROOM_ID_LENGTH = 5;
export const LEGACY_ROOM_ID_LENGTH = INVITE_CODE_LENGTH;

/** Random room id from the invite alphabet. Rejection sampling, like newInviteCode. */
export function newRoomId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const limit = 256 - (256 % INVITE_CODE_ALPHABET.length);
  let out = "";
  while (out.length < ROOM_ID_LENGTH) {
    for (const b of random(ROOM_ID_LENGTH)) {
      if (b < limit && out.length < ROOM_ID_LENGTH) out += INVITE_CODE_ALPHABET[b % INVITE_CODE_ALPHABET.length];
    }
  }
  return out;
}

/**
 * Accepts a typed room id: any case, spaces or dashes. Both the 5-character
 * id and the legacy 10-character id are valid. Returns null otherwise.
 */
export function normalizeRoomId(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== ROOM_ID_LENGTH && code.length !== LEGACY_ROOM_ID_LENGTH) return null;
  for (const ch of code) if (!INVITE_CODE_ALPHABET.includes(ch)) return null;
  return code;
}
