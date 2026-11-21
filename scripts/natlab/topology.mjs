/**
 * Н8 NAT lab: the scenario matrix and the network each scenario builds. Pure functions: they
 * return the shell commands (arrays, no shell), so tests check the plan without root.
 *
 *     hA (10.0.1.2 / 2001:db8:a::2)                         hB (10.0.2.2 / 2001:db8:b::2)
 *        │ lan A                                                 │ lan B
 *     rA (NAT) 198.51.100.10 ──── wan (a router) ──── 203.0.113.20 (NAT) rB
 *                                  │ STUN 192.0.2.1 / [2001:db8:ffff::1]:3478
 *
 * The wan namespace is a router, not a bridge: a packet from hA to hB crosses three routers, so
 * a packet sent with TTL 2 opens hA's own NAT but dies in the wan (the "low TTL" trick that
 * birthday punching uses, П4).
 *
 * NAT types, with Linux netfilter:
 *  - "cone": full cone. MASQUERADE out (Linux keeps the source port, so the mapping is
 *    endpoint-independent) and DNAT of any new inbound UDP to the one host behind it
 *    (endpoint-independent filtering), like a home router with the device in its DMZ.
 *    Plain MASQUERADE alone is not used for "cone": the other side's first checks arrive before
 *    anything left, conntrack records them, and that entry takes the very port the outgoing
 *    mapping needs, so Linux picks another one and every check refreshes the clash.
 *  - "restricted": plain MASQUERADE: endpoint-independent mapping, address-and-port dependent
 *    filtering (port-restricted cone). WebRTC fails against symmetric from here; П4's birthday
 *    punching with low-TTL packets does not.
 *  - "symmetric": MASQUERADE --random-fully. A new random port for every destination.
 * IPv6 is routed without NAT, like most real IPv6 networks.
 */

export const NS = { wan: "nl-wan", rA: "nl-rA", rB: "nl-rB", hA: "nl-hA", hB: "nl-hB" };
export const STUN_V4 = "192.0.2.1";
/** A second STUN address, so the native transport can tell cone from symmetric NAT (П4). */
export const STUN2_V4 = "192.0.2.2";
export const STUN_V6 = "2001:db8:ffff::1";
export const STUN_PORT = 3478;
export const STUN_URLS = `stun:${STUN_V4}:${STUN_PORT},stun:[${STUN_V6}]:${STUN_PORT}`;

const SIDE = {
  A: { r: NS.rA, h: NS.hA, net4: "198.51.100", wan4: "198.51.100.10", net6: "2001:db8:fa", wan6: "2001:db8:fa::10", lan4: "10.0.1", lan6: "2001:db8:a", tag: "a" },
  B: { r: NS.rB, h: NS.hB, net4: "203.0.113", wan4: "203.0.113.20", net6: "2001:db8:fb", wan6: "2001:db8:fb::20", lan4: "10.0.2", lan6: "2001:db8:b", tag: "b" },
};

/** The public address each side's router shows the world (for tests and the native lab). */
export function publicAddress(side) {
  return SIDE[side].wan4;
}

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
    name: "restricted-symmetric",
    note: "port-restricted cone against symmetric: WebRTC has no path (П4 native punching does, see native-*)",
    a: { nat: "restricted", family: "v4" },
    b: { nat: "symmetric", family: "v4" },
    expect: { connect: false, causeA: "nat", causeB: "nat" },
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

/**
 * П4: the native transport (scripts/natlab/native.mjs) on the same networks. No browser: the two
 * processes are the shells' UDP part. restricted ↔ symmetric is where WebRTC fails (above) and
 * birthday punching must not.
 */
export const NATIVE_SCENARIOS = [
  { name: "native-restricted-restricted", a: { nat: "restricted", family: "v4" }, b: { nat: "restricted", family: "v4" }, expect: { connect: true, strategy: "direct" } },
  { name: "native-restricted-symmetric", a: { nat: "restricted", family: "v4" }, b: { nat: "symmetric", family: "v4" }, expect: { connect: true, strategy: "birthday-cone" } },
  {
    name: "native-restricted-symmetric-lossy",
    a: { nat: "restricted", family: "v4" },
    b: { nat: "symmetric", family: "v4" },
    impair: { lossPct: 3 },
    expect: { connect: true, strategy: "birthday-cone" },
  },
  { name: "native-symmetric-symmetric", a: { nat: "symmetric", family: "v4" }, b: { nat: "symmetric", family: "v4" }, expect: { connect: false } },
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

  // WAN: a router with one link to each side's router; STUN listens on its loopback.
  cmds.push(nsx(NS.wan, "sysctl", "-qw", "net.ipv4.ip_forward=1"));
  cmds.push(nsx(NS.wan, "ip", "addr", "add", `${STUN_V4}/32`, "dev", "lo"));
  cmds.push(nsx(NS.wan, "ip", "addr", "add", `${STUN2_V4}/32`, "dev", "lo"));
  if (ipv6) {
    cmds.push(nsx(NS.wan, "sysctl", "-qw", "net.ipv6.conf.all.forwarding=1"));
    cmds.push(nsx(NS.wan, "ip", "-6", "addr", "add", `${STUN_V6}/128`, "dev", "lo"));
  }

  for (const key of ["A", "B"]) {
    const s = SIDE[key];
    const cfg = key === "A" ? scenario.a : scenario.b;
    const wanIf = `w${s.tag}`; // router side of the wan link
    const brIf = `x${s.tag}`; // wan side
    const lanR = `l${s.tag}`; // router side of the lan link
    const lanH = `e${s.tag}`; // host side
    const v4 = cfg.family !== "v6";
    const v6 = cfg.family !== "v4";

    // Router ⇄ wan router
    cmds.push(["ip", "link", "add", wanIf, "netns", s.r, "type", "veth", "peer", "name", brIf, "netns", NS.wan]);
    cmds.push(nsx(NS.wan, "ip", "link", "set", brIf, "up"));
    cmds.push(nsx(NS.wan, "ip", "addr", "add", `${s.net4}.1/24`, "dev", brIf));
    cmds.push(nsx(s.r, "ip", "link", "set", wanIf, "up"));
    cmds.push(nsx(s.r, "ip", "addr", "add", `${s.wan4}/24`, "dev", wanIf));
    cmds.push(nsx(s.r, "ip", "route", "add", "default", "via", `${s.net4}.1`));
    cmds.push(nsx(s.r, "sysctl", "-qw", "net.ipv4.ip_forward=1"));
    if (ipv6) {
      cmds.push(nsx(NS.wan, "ip", "-6", "addr", "add", `${s.net6}::1/64`, "dev", brIf, "nodad"));
      cmds.push(nsx(s.r, "ip", "-6", "addr", "add", `${s.wan6}/64`, "dev", wanIf, "nodad"));
      cmds.push(nsx(s.r, "ip", "-6", "route", "add", "default", "via", `${s.net6}::1`));
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
      // The wan router reaches this LAN through this router (the other router via its default).
      cmds.push(nsx(NS.wan, "ip", "-6", "route", "add", `${s.lan6}::/64`, "via", s.wan6));
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
