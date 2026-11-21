/**
 * Optional, user-configured TURN relay.
 *
 * Off by default. The app ships no TURN server and no credentials: the person enters their
 * own turn:/turns: URL, username and credential in Settings. Everything stays end-to-end
 * encrypted over a relay (the data channel carries DTLS, and the messages inside are
 * encrypted again by the Double Ratchet), so a relay sees traffic metadata (IP addresses,
 * timing, sizes) but not content.
 *
 * This module is pure: validation and the RTCConfiguration builder. Persistence is in
 * turnStore.ts (encrypted at rest). WebRTC ICE connections are not governed by the CSP
 * `connect-src` directive (it covers fetch, XHR, WebSocket, EventSource and beacons), so
 * the policy in vite.config.ts needs no change for TURN.
 */

export interface TurnSettings {
  enabled: boolean;
  /** `turn:host[:port][?transport=udp|tcp]` or `turns:...`. No credentials inside the URL. */
  url: string;
  username: string;
  credential: string;
  /** Use only relayed candidates: hides this device's IP from the other person and from STUN. */
  relayOnly: boolean;
}

export const DEFAULT_TURN_SETTINGS: TurnSettings = {
  enabled: false,
  url: "",
  username: "",
  credential: "",
  relayOnly: false,
};

/** Stable codes; the UI translates them (services do not depend on the language). */
export type TurnErrorCode =
  | "URL_EMPTY"
  | "URL_SCHEME"
  | "URL_EMBEDDED_CREDENTIALS"
  | "URL_FORMAT"
  | "URL_HOST"
  | "URL_PORT"
  | "URL_QUERY"
  | "URL_TOO_LONG"
  | "USERNAME_EMPTY"
  | "CREDENTIAL_EMPTY"
  | "FIELD_TOO_LONG"
  | "FIELD_CONTROL_CHARS";

export type TurnWarningCode =
  /** Host is loopback, private, link-local or a .local name: the other person cannot reach it. */
  | "PRIVATE_HOST"
  /** `turn:` (not `turns:`): the TURN control channel is not TLS-wrapped. Content is still E2EE. */
  | "PLAIN_TURN";

export type TurnUrlResult =
  | { ok: true; url: string; secure: boolean; host: string; port: number; warnings: TurnWarningCode[] }
  | { ok: false; error: TurnErrorCode };

const MAX_URL = 255;
const MAX_FIELD = 512;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

function parseIpv4(host: string): number[] | null {
  const m = IPV4.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * Full structural IPv6 check (RFC 4291 text form, no zone id): hextets of 1 to 4 hex digits,
 * at most one "::", exactly 8 groups (fewer only with "::", which stands for at least one
 * zero group), and an optional dotted IPv4 tail that counts as two groups.
 */
export function isValidIpv6(text: string): boolean {
  if (!text || text.length > 45) return false;
  const halves = text.split("::");
  if (halves.length > 2) return false;
  const groupsOf = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const all = [...groupsOf(halves[0]), ...(halves.length === 2 ? groupsOf(halves[1]) : [])];
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const g = all[i];
    if (g.includes(".")) {
      // Embedded IPv4 only at the very end of the text ("1.2.3.4::" is not valid).
      if (i !== all.length - 1 || text.endsWith(":") || !parseIpv4(g)) return false;
      count += 2;
    } else if (HEXTET.test(g)) {
      count += 1;
    } else {
      return false; // empty group (":::" or a stray leading/trailing ":"), >4 digits, non-hex
    }
  }
  return halves.length === 2 ? count <= 7 : count === 8;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  const v4 = parseIpv4(h);
  if (v4) return isPrivateIpv4(v4);
  if (h.startsWith("[")) {
    const inner = h.slice(1, -1);
    return (
      inner === "::1" ||
      inner === "::" ||
      /^f[cd]/.test(inner) || // unique local fc00::/7
      /^fe[89ab]/.test(inner) || // link-local fe80::/10
      /^::ffff:/.test(inner) // IPv4-mapped: judged conservatively
    );
  }
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".");
}

/**
 * Accepts only `turn:` / `turns:` URLs of the form `scheme:host[:port][?transport=udp|tcp]`.
 * Rejects embedded credentials (`user:pass@host`), other schemes, paths, fragments and
 * anything with whitespace. Private-range hosts are allowed (a home server on the LAN is a
 * legitimate test setup) but produce a warning.
 */
export function validateTurnUrl(input: string): TurnUrlResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "URL_EMPTY" };
  if (raw.length > MAX_URL) return { ok: false, error: "URL_TOO_LONG" };
  if (CONTROL.test(raw) || /\s/.test(raw)) return { ok: false, error: "URL_FORMAT" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme !== "turn" && scheme !== "turns") return { ok: false, error: "URL_SCHEME" };
  const rest = raw.slice(scheme.length + 1);

  if (rest.includes("@")) return { ok: false, error: "URL_EMBEDDED_CREDENTIALS" };
  if (rest.startsWith("//") || rest.includes("#") || /[/\\]/.test(rest)) return { ok: false, error: "URL_FORMAT" };

  const qIdx = rest.indexOf("?");
  const authority = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const query = qIdx === -1 ? "" : rest.slice(qIdx + 1);
  if (query && !/^transport=(udp|tcp)$/i.test(query)) return { ok: false, error: "URL_QUERY" };

  let host: string;
  let portText = "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) return { ok: false, error: "URL_HOST" };
    host = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after) {
      if (!after.startsWith(":")) return { ok: false, error: "URL_HOST" };
      portText = after.slice(1);
    }
    if (!isValidIpv6(host.slice(1, -1))) return { ok: false, error: "URL_HOST" };
  } else {
    const colon = authority.indexOf(":");
    host = colon === -1 ? authority : authority.slice(0, colon);
    if (colon !== -1) portText = authority.slice(colon + 1);
    if (authority.split(":").length > 2) return { ok: false, error: "URL_HOST" };
    if (!host || (!HOSTNAME.test(host) && !parseIpv4(host))) return { ok: false, error: "URL_HOST" };
    if (/^[\d.]+$/.test(host) && !parseIpv4(host)) return { ok: false, error: "URL_HOST" };
  }

  const secure = scheme === "turns";
  let port = secure ? 5349 : 3478;
  // "host:" with nothing after the colon is a typo, not "default port".
  const hasColon = authority.startsWith("[") ? authority.slice(authority.indexOf("]") + 1).startsWith(":") : authority.includes(":");
  if (hasColon && portText === "") return { ok: false, error: "URL_PORT" };
  if (portText) {
    if (!/^\d{1,5}$/.test(portText)) return { ok: false, error: "URL_PORT" };
    port = Number(portText);
    if (port < 1 || port > 65535) return { ok: false, error: "URL_PORT" };
  }

  const warnings: TurnWarningCode[] = [];
  if (isPrivateHost(host)) warnings.push("PRIVATE_HOST");
  if (!secure) warnings.push("PLAIN_TURN");

  const normalized = `${scheme}:${host.toLowerCase()}${portText ? `:${port}` : ""}${query ? `?transport=${query.slice(10).toLowerCase()}` : ""}`;
  return { ok: true, url: normalized, secure, host, port, warnings };
}

export type TurnValidation =
  | { ok: true; settings: TurnSettings; warnings: TurnWarningCode[] }
  | { ok: false; error: TurnErrorCode; field: "url" | "username" | "credential" };

/** Validates the whole form. A disabled config is accepted as-is only if all fields are empty or valid. */
export function validateTurnSettings(input: TurnSettings): TurnValidation {
  const u = validateTurnUrl(input.url);
  if (!u.ok) return { ok: false, error: u.error, field: "url" };
  for (const [field, value] of [
    ["username", input.username],
    ["credential", input.credential],
  ] as const) {
    if (!value) return { ok: false, error: field === "username" ? "USERNAME_EMPTY" : "CREDENTIAL_EMPTY", field };
    if (value.length > MAX_FIELD) return { ok: false, error: "FIELD_TOO_LONG", field };
    if (CONTROL.test(value)) return { ok: false, error: "FIELD_CONTROL_CHARS", field };
  }
  return {
    ok: true,
    settings: { ...input, url: u.url },
    warnings: u.warnings,
  };
}

/** Parses stored JSON defensively; anything malformed or invalid yields null (= TURN off). */
export function parseTurnSettings(value: unknown): TurnSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.enabled !== "boolean" ||
    typeof v.url !== "string" ||
    typeof v.username !== "string" ||
    typeof v.credential !== "string" ||
    typeof v.relayOnly !== "boolean"
  ) {
    return null;
  }
  const checked = validateTurnSettings({
    enabled: v.enabled,
    url: v.url,
    username: v.username,
    credential: v.credential,
    relayOnly: v.relayOnly,
  });
  return checked.ok ? checked.settings : null;
}

/** The only STUN server used when TURN is off or not relay-only (NAT discovery, no data). */
export const STUN_SERVERS: RTCIceServer[] = [{ urls: stunUrls(import.meta.env.VITE_STUN_URLS) }];

/**
 * The STUN URLs: the public default, or a build-time list (VITE_STUN_URLS, comma separated).
 * Only the NAT lab (scripts/natlab) sets it, to point at its own STUN server; releases never do.
 * Anything that is not a stun: URL is dropped, so a typo cannot add a TURN server.
 */
export function stunUrls(raw: unknown): string[] {
  const list = typeof raw === "string" ? raw.split(",").map((u) => u.trim()).filter((u) => /^stuns?:[^\s]+$/i.test(u)) : [];
  return list.length > 0 ? list : ["stun:stun.l.google.com:19302"];
}

/**
 * RTCConfiguration for a new connection. With no (or disabled) TURN settings this is exactly
 * the STUN-only default. `relayOnly` is honoured only when a TURN server is actually
 * configured, and then STUN is left out too: no packet from this device reaches anything but
 * the relay, so the other person sees the relay's address, not this device's.
 */
export function buildRtcConfiguration(turn: TurnSettings | null): RTCConfiguration {
  if (!turn || !turn.enabled) return { iceServers: STUN_SERVERS };
  const checked = validateTurnSettings(turn);
  if (!checked.ok) return { iceServers: STUN_SERVERS }; // never half-apply an invalid config
  const server: RTCIceServer = {
    urls: [checked.settings.url],
    username: checked.settings.username,
    credential: checked.settings.credential,
  };
  if (checked.settings.relayOnly) return { iceServers: [server], iceTransportPolicy: "relay" };
  return { iceServers: [...STUN_SERVERS, server] };
}

// In-memory only. Filled after unlock from the encrypted store, cleared on lock.
let active: TurnSettings | null = null;

export function setActiveTurn(settings: TurnSettings | null): void {
  active = settings && settings.enabled ? settings : null;
}

export function getActiveTurn(): TurnSettings | null {
  return active;
}
