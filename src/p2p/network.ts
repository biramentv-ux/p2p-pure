/**
 * Reads the ICE candidates in a local SDP and says whether a remote peer on
 * mobile data could plausibly reach this device. By default there is no relay; if the person
 * configured their own TURN server (src/p2p/turnConfig.ts) a `typ relay` candidate shows the
 * relay was reached, which works on almost any network. The browser exposes no direct
 * "do I have IPv6" API, so the gathered candidates are the evidence.
 */
export interface CandidateSummary {
  /** Real (not mDNS-obfuscated) IPv6 address seen as host or server-reflexive. */
  publicIpv6: boolean;
  /** IPv4 address learned from STUN (srflx). Behind carrier NAT this alone often fails. */
  publicIpv4: boolean;
  /** Host candidates hidden behind a .local name; a remote peer cannot resolve those. */
  hiddenHost: boolean;
  /** A candidate allocated on the user's own TURN relay. */
  relay: boolean;
  /** Only relay candidates were gathered (relay-only mode): this device's IP is not in the SDP. */
  relayOnly: boolean;
  /** STUN answered: at least one server-reflexive candidate. None usually means UDP is blocked. */
  srflx: boolean;
  /** Any IPv4 / IPv6 address at all (host or srflx), private ones included. */
  anyIpv4: boolean;
  anyIpv6: boolean;
  total: number;
}

export type Reachability = "relay" | "good" | "maybe" | "poor";

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPublicIpv6(addr: string): boolean {
  if (!addr.includes(":")) return false;
  const a = addr.toLowerCase();
  // Global unicast is 2000::/3. Link-local fe80::, unique-local fc00::/7 and loopback are not reachable.
  return /^[23]/.test(a);
}

export function summarizeCandidates(sdp: string): CandidateSummary {
  const summary: CandidateSummary = {
    publicIpv6: false,
    publicIpv4: false,
    hiddenHost: false,
    relay: false,
    relayOnly: false,
    srflx: false,
    anyIpv4: false,
    anyIpv6: false,
    total: 0,
  };
  let nonRelay = 0;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("a=candidate:")) continue;
    const parts = line.slice("a=candidate:".length).split(/\s+/);
    // foundation component protocol priority address port "typ" type ...
    const addr = parts[4];
    const typ = parts[6] === "typ" ? parts[7] : undefined;
    if (!addr || !typ) continue;
    summary.total++;
    if (typ === "relay") {
      summary.relay = true;
      continue;
    }
    nonRelay++;
    if (addr.endsWith(".local")) {
      summary.hiddenHost = true;
      continue;
    }
    if (typ === "srflx") summary.srflx = true;
    if (addr.includes(":")) {
      // Link-local fe80:: does not leave the network segment: not evidence of IPv6 connectivity.
      if (!/^fe80:/i.test(addr)) summary.anyIpv6 = true;
    } else summary.anyIpv4 = true;
    if (isPublicIpv6(addr) && (typ === "host" || typ === "srflx")) summary.publicIpv6 = true;
    if (typ === "srflx" && !addr.includes(":") && !PRIVATE_V4.test(addr)) summary.publicIpv4 = true;
  }
  summary.relayOnly = summary.relay && nonRelay === 0;
  return summary;
}

export function reachability(s: CandidateSummary): Reachability {
  // A relay allocation is the strongest signal: it works through CGNAT and strict firewalls.
  if (s.relay) return "relay";
  if (s.publicIpv6) return "good";
  if (s.publicIpv4) return "maybe";
  return "poor";
}

/** Short Bulgarian explanation shown next to the invitation. */
export function describeReachability(s: CandidateSummary): string {
  switch (reachability(s)) {
    case "relay":
      return s.relayOnly
        ? "Връзката ще мине само през твоя TURN релей. Другият човек не вижда IP адреса ти. Релеят вижда метаданни (IP адреси, време, размер), но не и съдържанието."
        : "Твоят TURN релей е достъпен. Ако директна връзка не успее, тя ще мине през релея. Релеят вижда метаданни (IP адреси, време, размер), но не и съдържанието.";
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

/**
 * Why a connection did not establish, from both sides' candidates (ours, and the ones in the
 * other person's invitation or answer). Checked in the NAT lab (scripts/natlab) for every scenario.
 *
 *  - "relay": we had a TURN relay and still failed (wrong TURN settings, or it is down).
 *  - "udp-blocked-here" / "udp-blocked-there": STUN never answered on that side and it has no
 *    public IPv6: the network blocks UDP (or outgoing STUN).
 *  - "family-mismatch": one side has only IPv6, the other only IPv4. They cannot meet without a relay.
 *  - "nat": both have only a NAT'ed IPv4 address. Usually symmetric NAT or carrier NAT (CGNAT)
 *    on at least one side.
 *  - "unknown": nothing in the candidates explains it (a firewall on the path, a timeout).
 */
export type FailureCause = "relay" | "udp-blocked-here" | "udp-blocked-there" | "family-mismatch" | "nat" | "unknown";

export function diagnoseFailure(mySdp: string, peerSdp?: string | null): FailureCause {
  const me = summarizeCandidates(mySdp);
  if (me.relay) return "relay";
  const peer = peerSdp ? summarizeCandidates(peerSdp) : null;
  if (peer && peer.total > 0) {
    const v6Only = (s: CandidateSummary) => s.publicIpv6 && !s.anyIpv4;
    const v4Only = (s: CandidateSummary) => !s.anyIpv6 && s.anyIpv4;
    if ((v6Only(me) && v4Only(peer)) || (v4Only(me) && v6Only(peer))) return "family-mismatch";
  }
  if (!me.srflx && !me.publicIpv6 && me.total > 0) return "udp-blocked-here";
  if (peer && peer.total > 0 && !peer.relay && !peer.srflx && !peer.publicIpv6) return "udp-blocked-there";
  if (me.publicIpv4 && !me.publicIpv6 && peer && peer.publicIpv4 && !peer.publicIpv6) return "nat";
  return "unknown";
}

/** What to tell the person for each cause (Bulgarian source text; the screen translates it). */
export function describeFailure(cause: FailureCause): string {
  switch (cause) {
    case "relay":
      return "Връзката не се установи и през TURN релея. Провери адреса, потребителя и паролата му в раздел Идентичност.";
    case "udp-blocked-here":
      return "Твоята мрежа не пропуска UDP (STUN не отговори). Директна връзка от тази мрежа няма да мине. Опитай друга Wi-Fi мрежа, мобилни данни или собствен TURN релей.";
    case "udp-blocked-there":
      return "Мрежата на другия човек не пропуска UDP (STUN не отговори там). Нека той опита друга Wi-Fi мрежа, мобилни данни или собствен TURN релей.";
    case "family-mismatch":
      return "Едното устройство е само с IPv6, а другото само с IPv4. Те не могат да се свържат директно. Нека едното смени мрежата (например Wi-Fi вместо мобилни данни) или ползвайте TURN релей.";
    case "nat":
      return "И двете устройства са зад NAT и директната връзка не мина. Обикновено поне едното е зад симетричен NAT или NAT на оператора (CGNAT). Опитайте с една Wi-Fi мрежа или собствен TURN релей.";
    default:
      return "Връзката не се установи навреме. Мрежата може да блокира директната връзка. Опитайте с една Wi-Fi мрежа за първото сдвояване.";
  }
}
