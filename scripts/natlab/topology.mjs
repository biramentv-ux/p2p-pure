/**
 * Н8 NAT lab: the scenario matrix and the network each scenario builds. Pure functions: they
 * return the shell commands (arrays, no shell), so tests check the plan without root.
 *
 *            hA (10.0.1.2 / 2001:db8:a::2)            hB (10.0.2.2 / 2001:db8:b::2)
 *               │ lan A                                    │ lan B
 *            rA (NAT) 203.0.113.10                      rB (NAT) 203.0.113.20
 *               └────────── wan bridge (203.0.113.0/24, 2001:db8:ffff::/64) ──┘
 *                                    │
 *                          STUN 203.0.113.1 / 2001:db8:ffff::1 :3478
 *
 * NAT types, with Linux netfilter:
 *  - "cone": full cone. MASQUERADE out (Linux keeps the source port, so the mapping is
 *    endpoint-independent) and DNAT of any new inbound UDP to the one host behind it
 *    (endpoint-independent filtering), like a home router with the device in its DMZ.
 *    Plain MASQUERADE alone is not used for "cone": the other side's first checks arrive before
 *    anything left, conntrack records them, and that entry takes the very port the outgoing
 *    mapping needs, so Linux picks another one and every check refreshes the clash.
 *  - "symmetric": MASQUERADE --random-fully. A new random port for every destination.
 * IPv6 is routed without NAT, like most real IPv6 networks.
 */

export const NS = { wan: "nl-wan", rA: "nl-rA", rB: "nl-rB", hA: "nl-hA", hB: "nl-hB" };
export const STUN_V4 = "203.0.113.1";
export const STUN_V6 = "2001:db8:ffff::1";
export const STUN_PORT = 3478;
export const STUN_URLS = `stun:${STUN_V4}:${STUN_PORT},stun:[${STUN_V6}]:${STUN_PORT}`;

const SIDE = {
  A: { r: NS.rA, h: NS.hA, wan4: "203.0.113.10", wan6: "2001:db8:ffff::10", lan4: "10.0.1", lan6: "2001:db8:a", tag: "a" },
  B: { r: NS.rB, h: NS.hB, wan4: "203.0.113.20", wan6: "2001:db8:ffff::20", lan4: "10.0.2", lan6: "2001:db8:b", tag: "b" },
};

/**
 * The matrix. `expect.connect` is what must happen; for a failure, `expect.causeA/causeB` is
 * the diagnosis (src/p2p/network.ts diagnoseFailure) each side's screen must show.
 */
export const SCENARIOS = [
  {
    name: "cone-cone",
    a: { nat: "cone", family: "v4" },
    b: { nat: "cone", family: "v4" },
    expect: { connect: true },
  },
  {
    name: "cone-cone-lossy",
    note: "2% loss each way (+60±20 ms where netem exists)",
    a: { nat: "cone", family: "v4" },
    b: { nat: "cone", family: "v4" },
    impair: { lossPct: 2, delayMs: 60, jitterMs: 20 },
    expect: { connect: true },
  },
  {
    name: "cone-symmetric",
    note: "the full cone side accepts the symmetric side's new port (peer-reflexive candidate)",
    a: { nat: "cone", family: "v4" },
    b: { nat: "symmetric", family: "v4" },
    expect: { connect: true },
  },
  {
    name: "symmetric-symmetric",
    a: { nat: "symmetric", family: "v4" },
    b: { nat: "symmetric", family: "v4" },
    expect: { connect: false, causeA: "nat", causeB: "nat" },
  },
  {
    name: "ipv6-both",
    note: "both on IPv6 only: routed, no NAT, connects",
    a: { nat: "cone", family: "v6" },
    b: { nat: "cone", family: "v6" },
    expect: { connect: true },
  },
  {
    name: "ipv6-only-vs-ipv4",
    a: { nat: "cone", family: "v6" },
    b: { nat: "cone", family: "v4" },
    expect: { connect: false, causeA: "family-mismatch", causeB: "family-mismatch" },
  },
  {
    name: "udp-blocked",
    a: { nat: "cone", family: "v4", blockUdp: true },
    b: { nat: "cone", family: "v4" },
    expect: { connect: false, causeA: "udp-blocked-here", causeB: "udp-blocked-there" },
  },
];

const nsx = (ns, ...cmd) => ["ip", "netns", "exec", ns, ...cmd];

/** True when the scenario needs IPv6 somewhere (skipped on a kernel without IPv6). */
export function needsIpv6(scenario) {
  return scenario.a.family !== "v4" || scenario.b.family !== "v4";
}

/**
 * Commands that build one scenario's network. `netem`: tc netem is available; `ipv6`: the kernel
 * has IPv6 (some containers have none: then only IPv4 scenarios run, with no IPv6 setup at all).
 */
export function planScenario(scenario, { netem = true, ipv6 = true } = {}) {
  if (!ipv6 && needsIpv6(scenario)) throw new Error(`${scenario.name} needs IPv6`);
  const cmds = [];
  for (const ns of Object.values(NS)) cmds.push(["ip", "netns", "add", ns]);
  for (const ns of Object.values(NS)) cmds.push(nsx(ns, "ip", "link", "set", "lo", "up"));

  // WAN: a bridge in the wan namespace; STUN lives on it.
  cmds.push(nsx(NS.wan, "ip", "link", "add", "br0", "type", "bridge"));
  cmds.push(nsx(NS.wan, "ip", "link", "set", "br0", "up"));
  cmds.push(nsx(NS.wan, "ip", "addr", "add", `${STUN_V4}/24`, "dev", "br0"));
  if (ipv6) cmds.push(nsx(NS.wan, "ip", "-6", "addr", "add", `${STUN_V6}/64`, "dev", "br0", "nodad"));

  for (const key of ["A", "B"]) {
    const s = SIDE[key];
    const cfg = key === "A" ? scenario.a : scenario.b;
    const wanIf = `w${s.tag}`; // router side of the wan link
    const brIf = `br${s.tag}`; // bridge side
    const lanR = `l${s.tag}`; // router side of the lan link
    const lanH = `e${s.tag}`; // host side
    const v4 = cfg.family !== "v6";
    const v6 = cfg.family !== "v4";

    // Router ⇄ WAN bridge
    cmds.push(["ip", "link", "add", wanIf, "netns", s.r, "type", "veth", "peer", "name", brIf, "netns", NS.wan]);
    cmds.push(nsx(NS.wan, "ip", "link", "set", brIf, "master", "br0", "up"));
    cmds.push(nsx(s.r, "ip", "link", "set", wanIf, "up"));
    cmds.push(nsx(s.r, "ip", "addr", "add", `${s.wan4}/24`, "dev", wanIf));
    cmds.push(nsx(s.r, "sysctl", "-qw", "net.ipv4.ip_forward=1"));
    if (ipv6) {
      cmds.push(nsx(s.r, "ip", "-6", "addr", "add", `${s.wan6}/64`, "dev", wanIf, "nodad"));
      cmds.push(nsx(s.r, "sysctl", "-qw", "net.ipv6.conf.all.forwarding=1"));
    }

    // Host ⇄ router
    cmds.push(["ip", "link", "add", lanR, "netns", s.r, "type", "veth", "peer", "name", lanH, "netns", s.h]);
    cmds.push(nsx(s.r, "ip", "link", "set", lanR, "up"));
    cmds.push(nsx(s.h, "ip", "link", "set", lanH, "up"));
    if (v4) {
      cmds.push(nsx(s.r, "ip", "addr", "add", `${s.lan4}.1/24`, "dev", lanR));
      cmds.push(nsx(s.h, "ip", "addr", "add", `${s.lan4}.2/24`, "dev", lanH));
      cmds.push(nsx(s.h, "ip", "route", "add", "default", "via", `${s.lan4}.1`));
      const masq = ["iptables", "-t", "nat", "-A", "POSTROUTING", "-o", wanIf, "-j", "MASQUERADE"];
      if (cfg.nat === "symmetric") masq.push("--random-fully");
      cmds.push(nsx(s.r, ...masq));
      if (cfg.nat === "cone") {
        cmds.push(nsx(s.r, "iptables", "-t", "nat", "-A", "PREROUTING", "-i", wanIf, "-p", "udp", "-j", "DNAT", "--to-destination", `${s.lan4}.2`));
      }
    }
    // An IPv6-only host simply gets no IPv4 address or route.
    if (v6) {
      cmds.push(nsx(s.r, "ip", "-6", "addr", "add", `${s.lan6}::1/64`, "dev", lanR, "nodad"));
      cmds.push(nsx(s.h, "ip", "-6", "addr", "add", `${s.lan6}::2/64`, "dev", lanH, "nodad"));
      cmds.push(nsx(s.h, "ip", "-6", "route", "add", "default", "via", `${s.lan6}::1`));
      // The wan side and the other router reach this LAN through this router.
      cmds.push(nsx(NS.wan, "ip", "-6", "route", "add", `${s.lan6}::/64`, "via", s.wan6));
      const other = key === "A" ? SIDE.B : SIDE.A;
      cmds.push(nsx(other.r, "ip", "-6", "route", "add", `${s.lan6}::/64`, "via", s.wan6));
    } else if (ipv6) {
      cmds.push(nsx(s.h, "sysctl", "-qw", "net.ipv6.conf.all.disable_ipv6=1"));
    }
    if (cfg.blockUdp) {
      cmds.push(nsx(s.r, "iptables", "-A", "FORWARD", "-p", "udp", "-j", "DROP"));
      if (ipv6) cmds.push(nsx(s.r, "ip6tables", "-A", "FORWARD", "-p", "udp", "-j", "DROP"));
    }
    if (scenario.impair) {
      const { lossPct = 0, delayMs = 0, jitterMs = 0 } = scenario.impair;
      if (netem) {
        const q = ["tc", "qdisc", "add", "dev", wanIf, "root", "netem"];
        if (delayMs) q.push("delay", `${delayMs}ms`, ...(jitterMs ? [`${jitterMs}ms`] : []));
        if (lossPct) q.push("loss", `${lossPct}%`);
        cmds.push(nsx(s.r, ...q));
      } else if (lossPct) {
        // No netem in this kernel: random loss with netfilter, both directions through the router.
        for (const tool of ipv6 ? ["iptables", "ip6tables"] : ["iptables"]) {
          cmds.push(nsx(s.r, tool, "-I", "FORWARD", "-m", "statistic", "--mode", "random", "--probability", String(lossPct / 100), "-j", "DROP"));
        }
      }
    }
  }
  return cmds;
}

export function teardown() {
  return Object.values(NS).map((ns) => ["ip", "netns", "del", ns]);
}

/** The namespace each side's browser runs in. */
export function hostNamespace(side) {
  return side === "A" ? NS.hA : NS.hB;
}
