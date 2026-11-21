// @vitest-environment node
/**
 * Н8 NAT lab, the parts that need no root: the STUN codec and the network plan of every
 * scenario. The lab itself (sudo node scripts/natlab/run.mjs) runs in CI (natlab.yml).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
// @ts-expect-error plain .mjs script without types
import { bindingResponse, MAGIC_COOKIE, parseBindingRequest, readMappedAddress } from "../../scripts/natlab/stun.mjs";
// @ts-expect-error plain .mjs script without types
import { needsIpv6, planScenario, SCENARIOS, STUN_URLS, teardown } from "../../scripts/natlab/topology.mjs";
import { stunUrls } from "../../src/p2p/turnConfig";
import { describeFailure } from "../../src/p2p/network";

function request(tid: Uint8Array): Uint8Array {
  const b = new Uint8Array(20);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1);
  v.setUint32(4, MAGIC_COOKIE);
  b.set(tid, 8);
  return b;
}

describe("Н8 lab STUN server", () => {
  it("answers a Binding request with the source address, IPv4 and IPv6, any port", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 12, maxLength: 12 }),
        fc.ipV4(),
        fc.integer({ min: 1, max: 65535 }),
        (tid, address, port) => {
          const req = parseBindingRequest(request(tid));
          expect(req).not.toBeNull();
          const res = bindingResponse(req!.transactionId, { family: "IPv4", address, port });
          expect(readMappedAddress(res)).toEqual({ family: "IPv4", address, port });
        },
      ),
    );
    const tid = new Uint8Array(12).fill(7);
    const v6 = readMappedAddress(bindingResponse(tid, { family: "IPv6", address: "2001:db8:a::2", port: 51000 }));
    expect(v6).toEqual({ family: "IPv6", address: "2001:db8:a:0:0:0:0:2", port: 51000 });
  });

  it("ignores anything that is not a well-formed Binding request", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 100 }), (b) => {
        const r = parseBindingRequest(b);
        if (r) expect(r.transactionId.length).toBe(12);
      }),
    );
    const wrongType = request(new Uint8Array(12));
    wrongType[1] = 0x11;
    expect(parseBindingRequest(wrongType)).toBeNull();
  });
});

describe("Н8 lab topology", () => {
  it("has the matrix from the plan, with a diagnosis for every expected failure", () => {
    const names = SCENARIOS.map((s: { name: string }) => s.name);
    for (const n of ["cone-cone", "cone-symmetric", "symmetric-symmetric", "ipv6-only-vs-ipv4", "udp-blocked"]) expect(names).toContain(n);
    for (const s of SCENARIOS) {
      if (s.expect.connect) continue;
      expect(describeFailure(s.expect.causeA)).not.toBe(describeFailure("unknown"));
      expect(describeFailure(s.expect.causeB)).not.toBe(describeFailure("unknown"));
    }
  });

  it("builds cone and symmetric NAT as planned", () => {
    const flat = (name: string) => planScenario(SCENARIOS.find((s: { name: string }) => s.name === name)).map((c: string[]) => c.join(" "));
    const cc = flat("cone-cone");
    expect(cc.filter((c: string) => c.includes("MASQUERADE")).length).toBe(2);
    expect(cc.some((c: string) => c.includes("--random-fully"))).toBe(false);
    expect(cc.filter((c: string) => c.includes("DNAT")).length).toBe(2);
    const ss = flat("symmetric-symmetric");
    expect(ss.filter((c: string) => c.includes("--random-fully")).length).toBe(2);
    expect(ss.some((c: string) => c.includes("DNAT"))).toBe(false);
    expect(flat("udp-blocked").some((c: string) => c.includes("FORWARD -p udp -j DROP"))).toBe(true);
  });

  it("uses netem when it exists, netfilter loss when it does not", () => {
    const lossy = SCENARIOS.find((s: { name: string }) => s.name === "cone-cone-lossy");
    const withNetem = planScenario(lossy, { netem: true }).map((c: string[]) => c.join(" "));
    const without = planScenario(lossy, { netem: false }).map((c: string[]) => c.join(" "));
    expect(withNetem.some((c: string) => c.includes("netem delay 60ms 20ms loss 2%"))).toBe(true);
    expect(without.some((c: string) => c.includes("statistic --mode random --probability 0.02"))).toBe(true);
  });

  it("leaves IPv6 out entirely on a kernel without it, and refuses IPv6 scenarios there", () => {
    for (const s of SCENARIOS) {
      if (needsIpv6(s)) expect(() => planScenario(s, { ipv6: false })).toThrow();
      else expect(planScenario(s, { ipv6: false }).some((c: string[]) => c.join(" ").includes("-6") || c.join(" ").includes("ipv6"))).toBe(false);
    }
    expect(teardown().length).toBe(5);
  });

  it("builds the lab app with only the lab STUN servers", () => {
    expect(stunUrls(STUN_URLS)).toEqual(["stun:203.0.113.1:3478", "stun:[2001:db8:ffff::1]:3478"]);
  });
});
