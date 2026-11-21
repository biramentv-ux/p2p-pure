import { describe, it, expect } from "vitest";
import { describeFailure, describeReachability, diagnoseFailure, reachability, summarizeCandidates } from "../../src/p2p/network";

const c = (addr: string, typ: string) =>
  `a=candidate:1 1 udp 2122260223 ${addr} 50000 typ ${typ} generation 0\r\n`;

describe("candidate summary", () => {
  it("detects a public IPv6 host or srflx address", () => {
    expect(summarizeCandidates(c("2a01:5a8:1:2::7", "host")).publicIpv6).toBe(true);
    expect(summarizeCandidates(c("2a01:5a8:1:2::7", "srflx")).publicIpv6).toBe(true);
  });

  it("does not count link-local, unique-local or loopback IPv6", () => {
    for (const a of ["fe80::1", "fd12:3456::1", "::1"]) {
      expect(summarizeCandidates(c(a, "host")).publicIpv6).toBe(false);
    }
  });

  it("counts only non-private STUN IPv4 as public", () => {
    expect(summarizeCandidates(c("85.14.3.9", "srflx")).publicIpv4).toBe(true);
    expect(summarizeCandidates(c("100.72.1.5", "srflx")).publicIpv4).toBe(false); // CGNAT range
    expect(summarizeCandidates(c("192.168.1.5", "host")).publicIpv4).toBe(false);
  });

  it("flags mDNS-hidden host candidates and ignores them as addresses", () => {
    const s = summarizeCandidates(c("a1b2c3d4-0000-0000-0000-000000000000.local", "host"));
    expect(s.hiddenHost).toBe(true);
    expect(s.publicIpv6).toBe(false);
    expect(s.total).toBe(1);
  });

  it("rates good, maybe and poor", () => {
    expect(reachability(summarizeCandidates(c("2a01::1", "host")))).toBe("good");
    expect(reachability(summarizeCandidates(c("85.14.3.9", "srflx")))).toBe("maybe");
    expect(reachability(summarizeCandidates(c("192.168.1.5", "host")))).toBe("poor");
  });

  it("explains the result in Bulgarian", () => {
    expect(describeReachability(summarizeCandidates(c("2a01::1", "host")))).toContain("IPv6");
    expect(describeReachability(summarizeCandidates(""))).toContain("вероятно няма да успее");
  });
});

describe("relay candidates (user's own TURN)", () => {
  const relay = c("198.51.100.20", "relay");

  it("recognises typ relay and relay-only SDPs", () => {
    const only = summarizeCandidates(relay);
    expect(only).toMatchObject({ relay: true, relayOnly: true, total: 1, publicIpv4: false });
    const mixed = summarizeCandidates(c("192.168.1.5", "host") + relay);
    expect(mixed).toMatchObject({ relay: true, relayOnly: false });
    expect(summarizeCandidates(c("85.14.3.9", "srflx"))).toMatchObject({ relay: false, relayOnly: false });
  });

  it("a relay candidate makes the invite reachable, not poor", () => {
    expect(reachability(summarizeCandidates(relay))).toBe("relay");
    expect(reachability(summarizeCandidates(c("192.168.1.5", "host") + relay))).toBe("relay");
    expect(reachability(summarizeCandidates(c("2a01::1", "host") + relay))).toBe("relay");
  });

  it("explains relay-only and relay fallback, never 'probably fails'", () => {
    const only = describeReachability(summarizeCandidates(relay));
    expect(only).toContain("само през твоя TURN релей");
    expect(only).toContain("не вижда IP адреса ти");
    const fallback = describeReachability(summarizeCandidates(c("192.168.1.5", "host") + relay));
    expect(fallback).toContain("релей е достъпен");
    for (const text of [only, fallback]) {
      expect(text).not.toContain("вероятно няма да успее");
      expect(text).toContain("не и съдържанието");
    }
  });

  it("both relay texts have English translations", async () => {
    const { translate } = await import("../../src/i18n");
    for (const sdp of [relay, c("192.168.1.5", "host") + relay]) {
      const bg = describeReachability(summarizeCandidates(sdp));
      expect(translate("en", bg)).not.toBe(bg);
      expect(translate("en", bg)).toContain("TURN relay");
    }
  });
});

describe("failure diagnosis (Н8, checked in the NAT lab too)", () => {
  const v4nat = c("10.0.1.2", "host") + c("203.0.113.10", "srflx");
  const v6only = c("2001:db8:1::2", "host") + c("fe80::1", "host");
  const udpBlocked = c("10.0.1.2", "host");

  it("names a relay that still failed", () => {
    expect(diagnoseFailure(c("203.0.113.5", "relay"), v4nat)).toBe("relay");
  });

  it("tells IPv6-only from IPv4-only, in both directions", () => {
    expect(diagnoseFailure(v6only, v4nat)).toBe("family-mismatch");
    expect(diagnoseFailure(v4nat, v6only)).toBe("family-mismatch");
    // Link-local IPv6 on an IPv4 network is not IPv6 connectivity.
    expect(diagnoseFailure(v4nat + c("fe80::2", "host"), v6only)).toBe("family-mismatch");
  });

  it("says which side blocks UDP", () => {
    expect(diagnoseFailure(udpBlocked, v4nat)).toBe("udp-blocked-here");
    expect(diagnoseFailure(v4nat, udpBlocked)).toBe("udp-blocked-there");
    expect(diagnoseFailure(udpBlocked)).toBe("udp-blocked-here");
  });

  it("calls two NAT'ed IPv4 sides a NAT problem", () => {
    expect(diagnoseFailure(v4nat, c("10.0.2.2", "host") + c("203.0.113.20", "srflx"))).toBe("nat");
  });

  it("falls back to unknown when the candidates do not explain it", () => {
    expect(diagnoseFailure(c("2001:db8:1::2", "host") + c("203.0.113.10", "srflx"), v4nat)).toBe("unknown");
    expect(diagnoseFailure("")).toBe("unknown");
  });

  it("has a message for every cause", () => {
    for (const cause of ["relay", "udp-blocked-here", "udp-blocked-there", "family-mismatch", "nat", "unknown"] as const) {
      expect(describeFailure(cause).length).toBeGreaterThan(20);
    }
  });
});
