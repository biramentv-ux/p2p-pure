import { describe, it, expect } from "vitest";
import { describeReachability, reachability, summarizeCandidates } from "../../src/p2p/network";

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
