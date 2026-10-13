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
