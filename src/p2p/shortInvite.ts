/**
 * Client side of short invitation codes. The Worker keeps one signed invitation
 * per 10-character code for 10 minutes and deletes it on the first fetch.
 * The alphabet and length must match worker/logic.ts.
 */

export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LENGTH = 10;

/** Base URL of the signaling Worker. Overridable at build time with VITE_INVITE_API. */
export const INVITE_API_BASE: string =
  (import.meta.env.VITE_INVITE_API as string | undefined) ?? "https://tg.dyrakarmy.online";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ShortInviteError extends Error {
  readonly code: "network" | "not_found" | "invalid_code" | "rejected" | "busy";
  constructor(message: string, code: ShortInviteError["code"]) {
    super(message);
    this.name = "ShortInviteError";
    this.code = code;
  }
}

/** Accepts what a person types (any case, spaces or dashes). Returns null if it cannot be a code. */
export function normalizeShortCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of code) if (!INVITE_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Shows a code as two groups of five, e.g. ABCDE-FGHJK, for reading aloud. */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Uploads a signed invitation and returns its short code. */
export async function shareInvitation(
  payload: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  base: string = INVITE_API_BASE,
): Promise<{ code: string; expiresInSec: number }> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitation: payload }),
    });
  } catch {
    throw new ShortInviteError("Няма връзка със сървъра за кодове.", "network");
  }
  if (res.status === 503) throw new ShortInviteError("Опитай пак след малко.", "busy");
  if (!res.ok) throw new ShortInviteError("Сървърът отказа поканата.", "rejected");
  const body = (await res.json().catch(() => null)) as { code?: unknown; expiresInSec?: unknown } | null;
  if (!body || typeof body.code !== "string" || typeof body.expiresInSec !== "number") {
    throw new ShortInviteError("Неочакван отговор от сървъра.", "rejected");
  }
  return { code: body.code, expiresInSec: body.expiresInSec };
}

/** Fetches the invitation for a code. Each code works once, so a second call fails. */
export async function fetchInvitation(
  input: string,
  fetchImpl: FetchLike = (u, i) => fetch(u, i),
  base: string = INVITE_API_BASE,
): Promise<string> {
  const code = normalizeShortCode(input);
  if (!code) throw new ShortInviteError("Кодът трябва да е 10 символа.", "invalid_code");
  let res: Response;
  try {
    res = await fetchImpl(`${base}/invite/${code}`, { method: "GET" });
  } catch {
    throw new ShortInviteError("Няма връзка със сървъра за кодове.", "network");
  }
  if (res.status === 404) {
    throw new ShortInviteError("Кодът не е валиден или вече е използван. Поискай нов.", "not_found");
  }
  if (!res.ok) throw new ShortInviteError("Сървърът не можа да провери кода.", "rejected");
  const body = (await res.json().catch(() => null)) as { invitation?: unknown } | null;
  if (!body || typeof body.invitation !== "string") {
    throw new ShortInviteError("Неочакван отговор от сървъра.", "rejected");
  }
  return body.invitation;
}
