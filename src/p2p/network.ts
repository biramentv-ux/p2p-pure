/**
 * Reads the ICE candidates in a local SDP and says whether a remote peer on
 * mobile data could plausibly reach this device without a relay (TURN is not
 * allowed). The browser exposes no direct "do I have IPv6" API, so the
 * gathered candidates are the evidence.
 */
export interface CandidateSummary {
  /** Real (not mDNS-obfuscated) IPv6 address seen as host or server-reflexive. */
  publicIpv6: boolean;
  /** IPv4 address learned from STUN (srflx). Behind carrier NAT this alone often fails. */
  publicIpv4: boolean;
  /** Host candidates hidden behind a .local name; a remote peer cannot resolve those. */
  hiddenHost: boolean;
  total: number;
}

export type Reachability = "good" | "maybe" | "poor";

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPublicIpv6(addr: string): boolean {
  if (!addr.includes(":")) return false;
  const a = addr.toLowerCase();
  // Global unicast is 2000::/3. Link-local fe80::, unique-local fc00::/7 and loopback are not reachable.
  return /^[23]/.test(a);
}

export function summarizeCandidates(sdp: string): CandidateSummary {
  const summary: CandidateSummary = { publicIpv6: false, publicIpv4: false, hiddenHost: false, total: 0 };
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("a=candidate:")) continue;
    const parts = line.slice("a=candidate:".length).split(/\s+/);
    // foundation component protocol priority address port "typ" type ...
    const addr = parts[4];
    const typ = parts[6] === "typ" ? parts[7] : undefined;
    if (!addr || !typ) continue;
    summary.total++;
    if (addr.endsWith(".local")) {
      summary.hiddenHost = true;
      continue;
    }
    if (isPublicIpv6(addr) && (typ === "host" || typ === "srflx")) summary.publicIpv6 = true;
    if (typ === "srflx" && !addr.includes(":") && !PRIVATE_V4.test(addr)) summary.publicIpv4 = true;
  }
  return summary;
}

export function reachability(s: CandidateSummary): Reachability {
  if (s.publicIpv6) return "good";
  if (s.publicIpv4) return "maybe";
  return "poor";
}

/** Short Bulgarian explanation shown next to the invitation. */
export function describeReachability(s: CandidateSummary): string {
  switch (reachability(s)) {
    case "good":
      return "Мрежата има публичен IPv6 адрес. Връзка от разстояние е възможна, ако и другото устройство има IPv6.";
    case "maybe":
      return "Има само IPv4 адрес през STUN. Връзка между две мобилни мрежи често не успява заради оператора (CGNAT). Опитайте, но може да се наложи Wi-Fi.";
    default:
      return s.hiddenHost
        ? "Адресите на устройството са скрити от браузъра. Връзка от разстояние вероятно няма да успее."
        : "Няма публичен адрес. Връзка от разстояние вероятно няма да успее.";
  }
}
