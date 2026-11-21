// @vitest-environment node
/**
 * П4 (experiment): port mapping codecs, hole punching against simulated NATs and the encrypted
 * datagram link over a lossy, reordering, duplicating network. The same punching code runs over
 * real Linux NATs in the lab (scripts/natlab/native.mjs).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isPrivateV4,
  natpmpMapRequest,
  parseIgdDescription,
  parseNatpmpExternalAddress,
  parseNatpmpMapResponse,
  parsePcpMapResponse,
  parseSoapResult,
  parseSsdpLocation,
  pcpMapRequest,
  PortMapError,
  ssdpSearch,
  upnpAddPortMapping,
} from "../../src/native/portmap";
import {
  BIRTHDAY_PROBES,
  BIRTHDAY_SOCKETS,
  chooseStrategy,
  decodePunch,
  encodePunch,
  hitProbability,
  punch,
  PunchError,
  punchToken,
  randomPorts,
  type NatKind,
  type PunchSocket,
} from "../../src/native/punch";
import { DatagramLink, MAX_FRAGMENT, type DatagramTransport } from "../../src/native/datagramLink";

const RUNS = Number(process.env.FUZZ_RUNS ?? 100);

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

// ------------------------------------------------------------------ port mapping

describe("П4 port mapping: NAT-PMP", () => {
  it("builds a UDP map request and reads the answer", () => {
    const req = natpmpMapRequest(51000, 51000, 7200);
    expect(Array.from(req)).toEqual([0, 1, 0, 0, 0xc7, 0x38, 0xc7, 0x38, 0, 0, 0x1c, 0x20]);
    const res = Uint8Array.from([0, 129, 0, 0, 0, 0, 0, 9, 0xc7, 0x38, 0xc7, 0x39, 0, 0, 0x1c, 0x20]);
    expect(parseNatpmpMapResponse(res)).toEqual({ protocol: "natpmp", internalPort: 51000, externalPort: 51001, lifetimeSec: 7200 });
    expect(parseNatpmpExternalAddress(Uint8Array.from([0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 7]))).toBe("203.0.113.7");
  });

  it("reports a refusal as such", () => {
    const res = Uint8Array.from([0, 129, 0, 2, 0, 0, 0, 9, 0xc7, 0x38, 0, 0, 0, 0, 0, 0]);
    expect(() => parseNatpmpMapResponse(res)).toThrow(/result 2/);
  });
});

describe("П4 port mapping: PCP", () => {
  const nonce = Uint8Array.from({ length: 12 }, (_, i) => i + 1);

  it("builds a MAP request and reads the answer with the same nonce", () => {
    const req = pcpMapRequest({ clientIp: "192.168.1.20", internalPort: 51000, lifetimeSec: 3600, nonce });
    expect(req.length).toBe(60);
    expect(req[0]).toBe(2);
    expect(req[1]).toBe(1);
    expect(Array.from(req.subarray(18, 24))).toEqual([0xff, 0xff, 192, 168, 1, 20]);
    const res = new Uint8Array(60);
    res[0] = 2;
    res[1] = 0x81;
    new DataView(res.buffer).setUint32(4, 3600);
    res.set(nonce, 24);
    res[36] = 17;
    new DataView(res.buffer).setUint16(40, 51000);
    new DataView(res.buffer).setUint16(42, 40123);
    res.set([0xff, 0xff, 198, 51, 100, 10], 54);
    expect(parsePcpMapResponse(res, nonce)).toEqual({ protocol: "pcp", internalPort: 51000, externalPort: 40123, externalAddress: "198.51.100.10", lifetimeSec: 3600 });
    const other = res.slice();
    other[24] ^= 1;
    expect(() => parsePcpMapResponse(other, nonce)).toThrow(/another request/);
  });

  it("tells a NAT-PMP-only router apart", () => {
    const res = new Uint8Array(60);
    try {
      parsePcpMapResponse(res, nonce);
    } catch (e) {
      expect((e as PortMapError).code).toBe("unsupported");
    }
  });

  it("any answer bytes throw only PortMapError", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (b) => {
        for (const f of [() => parsePcpMapResponse(b, nonce), () => parseNatpmpMapResponse(b), () => parseNatpmpExternalAddress(b)]) {
          try {
            f();
          } catch (e) {
            if (!(e instanceof PortMapError)) throw e;
          }
        }
      }),
      { numRuns: RUNS * 5 },
    );
  });
});

describe("П4 port mapping: UPnP-IGD", () => {
  it("searches, follows only a LAN http location, finds the WAN service, builds SOAP", () => {
    expect(ssdpSearch()).toContain("ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1");
    expect(parseSsdpLocation("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n")).toBe("http://192.168.1.1:5000/rootDesc.xml");
    // Anything that would make the app fetch elsewhere is refused.
    for (const loc of ["https://192.168.1.1/x", "http://8.8.8.8/x", "http://example.com/x", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(parseSsdpLocation(`HTTP/1.1 200 OK\r\nLocation: ${loc}\r\n\r\n`)).toBeNull();
    }
    const xml = `<root><device><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>/ctl/IPConn</controlURL></service>
    </serviceList></device></root>`;
    const svc = parseIgdDescription(xml, "http://192.168.1.1:5000/rootDesc.xml");
    expect(svc).toEqual({ controlUrl: "http://192.168.1.1:5000/ctl/IPConn", serviceType: "urn:schemas-upnp-org:service:WANIPConnection:2" });
    // A control URL on another host is refused.
    expect(parseIgdDescription(xml.replace("/ctl/IPConn", "http://10.9.9.9/x"), "http://192.168.1.1:5000/rootDesc.xml")).toBeNull();
    const soap = upnpAddPortMapping({ serviceType: svc!.serviceType, externalPort: 51000, internalPort: 51000, internalClient: "192.168.1.20", lifetimeSec: 3600, description: "a<b>&c" });
    expect(soap.body).toContain("<NewInternalClient>192.168.1.20</NewInternalClient>");
    expect(soap.body).toContain("a&#60;b&#62;&#38;c");
    expect(() => upnpAddPortMapping({ serviceType: "x", externalPort: 1, internalPort: 1, internalClient: "8.8.8.8", lifetimeSec: 1 })).toThrow(PortMapError);
    expect(parseSoapResult(500, "<s:Fault><detail><UPnPError><errorCode>718</errorCode></UPnPError></detail></s:Fault>")).toEqual({ ok: false, code: 718 });
    expect(parseSoapResult(200, "<NewExternalIPAddress>203.0.113.5</NewExternalIPAddress>")).toEqual({ ok: true, externalIp: "203.0.113.5" });
  });

  it("private address check", () => {
    for (const ip of ["10.0.0.1", "192.168.0.10", "172.16.5.4", "172.31.255.255"]) expect(isPrivateV4(ip)).toBe(true);
    for (const ip of ["172.32.0.1", "8.8.8.8", "100.64.0.1", "192.169.0.1", "10.0.0"]) expect(isPrivateV4(ip)).toBe(false);
  });

  it("any SSDP or XML text never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (t) => {
        parseSsdpLocation(t);
        parseIgdDescription(t, "http://192.168.1.1/x");
        parseSoapResult(200, t);
      }),
      { numRuns: RUNS * 5 },
    );
  });
});

// ------------------------------------------------------------------ punching

describe("П4 punching: packets and odds", () => {
  it("probes carry a token per direction; a foreign token is ignored", () => {
    const secret = new Uint8Array(32).fill(3);
    const a = punchToken(secret, "A");
    const b = punchToken(secret, "B");
    expect(a).not.toEqual(b);
    expect(decodePunch(encodePunch("probe", a), a)).toBe("probe");
    expect(decodePunch(encodePunch("ack", a), a)).toBe("ack");
    expect(decodePunch(encodePunch("probe", a), b)).toBeNull();
    expect(decodePunch(encodePunch("probe", punchToken(new Uint8Array(32), "A")), a)).toBeNull();
  });

  it("256 sockets and 1,750 probes hit with ≥ 99.9 %", () => {
    expect(hitProbability(BIRTHDAY_SOCKETS, BIRTHDAY_PROBES)).toBeGreaterThan(0.999);
    expect(hitProbability(1, 1)).toBeLessThan(0.0001);
  });

  it("random ports are distinct and in range", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.integer(), (n, seed) => {
        const ports = randomPorts(n, prng(seed));
        expect(new Set(ports).size).toBe(ports.length);
        expect(ports.every((p) => p >= 1024 && p <= 65535)).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it("picks the strategy from both NAT kinds", () => {
    expect(chooseStrategy("cone", "cone")).toBe("direct");
    expect(chooseStrategy("cone", "symmetric")).toBe("birthday-cone");
    expect(chooseStrategy("symmetric", "cone")).toBe("birthday-symmetric");
    expect(chooseStrategy("symmetric", "symmetric")).toBe("impossible");
    expect(chooseStrategy("unknown", "symmetric")).toBe("birthday-cone");
  });
});

/**
 * A small simulated internet: each host is behind its own NAT. Packets with TTL ≤ 2 open the
 * sender's mapping and die in the middle (as in the lab, three routers on the path).
 */
type SimKind = "full" | "restricted" | "symmetric";
class SimNat {
  readonly mapEim = new Map<number, number>(); // private port → public port
  readonly mapSym = new Map<string, number>(); // `${privPort}|${dst}` → public port
  readonly allowed = new Set<string>(); // `${pubPort}|${remote}` the host has sent to
  readonly owner = new Map<number, number>(); // public port → private port
  constructor(
    readonly kind: SimKind,
    readonly ip: string,
    readonly random: () => number,
  ) {}
  outbound(privPort: number, dst: string): number {
    let pub: number;
    if (this.kind === "symmetric") {
      const key = `${privPort}|${dst}`;
      pub = this.mapSym.get(key) ?? 0;
      if (!pub) {
        do pub = 1024 + Math.floor(this.random() * (65536 - 1024));
        while (this.owner.has(pub));
        this.mapSym.set(key, pub);
      }
    } else {
      pub = this.mapEim.get(privPort) ?? privPort;
      this.mapEim.set(privPort, pub);
    }
    this.owner.set(pub, privPort);
    this.allowed.add(`${pub}|${dst}`);
    return pub;
  }
  inbound(pubPort: number, from: string): number | null {
    const priv = this.owner.get(pubPort);
    if (priv === undefined) return null;
    if (this.kind === "full") return priv;
    return this.allowed.has(`${pubPort}|${from}`) ? priv : null;
  }
}

class SimNet {
  readonly nats = new Map<string, SimNat>();
  readonly sockets = new Map<string, (b: Uint8Array, port: number, host: string) => void>(); // `${natIp}|${privPort}`
  sent = 0;
  private nextPort = new Map<string, number>();
  addHost(ip: string, kind: SimKind, random: () => number): SimNat {
    const nat = new SimNat(kind, ip, random);
    this.nats.set(ip, nat);
    this.nextPort.set(ip, 40000);
    return nat;
  }
  open(ip: string): PunchSocket {
    const privPort = this.nextPort.get(ip)!;
    this.nextPort.set(ip, privPort + 1);
    const nat = this.nats.get(ip)!;
    const handlers = new Set<(b: Uint8Array, port: number, host: string) => void>();
    const key = `${ip}|${privPort}`;
    this.sockets.set(key, (b, port, host) => handlers.forEach((h) => h(b, port, host)));
    return {
      localPort: privPort,
      send: (bytes, port, host, ttl = 64) => {
        this.sent++;
        const pub = nat.outbound(privPort, `${host}:${port}`);
        if (ttl <= 2) return; // opened our NAT, died in the middle
        const peer = this.nats.get(host);
        if (!peer) return;
        const priv = peer.inbound(port, `${ip}:${pub}`);
        if (priv === null) return;
        const deliver = this.sockets.get(`${host}|${priv}`);
        if (deliver) setImmediate(() => deliver(bytes, pub, ip));
      },
      onMessage: (h) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      close: () => this.sockets.delete(key),
    };
  }
}

async function simulatedPunch(kindA: SimKind, kindB: SimKind, seed: number) {
  const net = new SimNet();
  const r = prng(seed);
  net.addHost("198.51.100.10", kindA, r);
  net.addHost("203.0.113.20", kindB, r);
  const secret = new Uint8Array(32).fill(seed & 0xff);
  const sa = net.open("198.51.100.10");
  const sb = net.open("203.0.113.20");
  // What STUN would have told each side (for EIM NATs the public port of the main socket).
  const pubA = kindA === "symmetric" ? 1 : sa.localPort;
  const pubB = kindB === "symmetric" ? 1 : sb.localPort;
  const natOf = (k: SimKind): NatKind => (k === "symmetric" ? "symmetric" : "cone");
  // Fake time for both sides: a sleep waits for the clock to reach its time; the scheduler moves
  // the clock to the earliest timer once nothing else is pending (packets go first).
  let clock = 0;
  const timers: Array<{ at: number; res: () => void }> = [];
  let running = true;
  const pump = () => {
    if (!running) return;
    if (timers.length) {
      timers.sort((x, y) => x.at - y.at);
      const t = timers.shift()!;
      clock = Math.max(clock, t.at);
      t.res();
    }
    setImmediate(pump);
  };
  setImmediate(pump);
  const common = {
    sleep: (ms: number) => new Promise<void>((res) => timers.push({ at: clock + ms, res })),
    now: () => clock,
    random: prng(seed * 7 + 1),
    timeoutMs: 25_000,
  };
  const [a, b] = await Promise.allSettled([
    punch({ side: "A", secret, me: natOf(kindA), peer: { host: "203.0.113.20", port: pubB, nat: natOf(kindB) }, socket: sa, openSocket: async () => net.open("198.51.100.10"), ...common }),
    punch({ side: "B", secret, me: natOf(kindB), peer: { host: "198.51.100.10", port: pubA, nat: natOf(kindA) }, socket: sb, openSocket: async () => net.open("203.0.113.20"), ...common }),
  ]);
  running = false;
  return { a, b, sent: net.sent };
}

describe("П4 punching against simulated NATs", () => {
  it("restricted cone ↔ restricted cone: direct", async () => {
    const { a, b } = await simulatedPunch("restricted", "restricted", 1);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
  });

  it("restricted cone ↔ symmetric: birthday punching succeeds for every seed tried", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { a, b } = await simulatedPunch("restricted", "symmetric", seed);
      expect(a.status, `seed ${seed}`).toBe("fulfilled");
      expect(b.status, `seed ${seed}`).toBe("fulfilled");
      if (a.status === "fulfilled") expect(a.value.strategy).toBe("birthday-cone");
      if (b.status === "fulfilled") expect(b.value.strategy).toBe("birthday-symmetric");
    }
  });

  it("symmetric ↔ symmetric: refuses at once (needs a relay)", async () => {
    const { a, b } = await simulatedPunch("symmetric", "symmetric", 3);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    if (a.status === "rejected") expect(a.reason).toBeInstanceOf(PunchError);
  });
});

// ------------------------------------------------------------------ datagram link

/** Two transports joined by a network that loses, duplicates and reorders. Time is manual. */
function lossyPair(seed: number, loss: number, dup: number) {
  const r = prng(seed);
  const queue: Array<{ to: 0 | 1; bytes: Uint8Array; at: number }> = [];
  const handlers: Array<Set<(b: Uint8Array) => void>> = [new Set(), new Set()];
  let clock = 0;
  const tamper = { next: false };
  const make = (me: 0 | 1): DatagramTransport => ({
    send: (bytes) => {
      if (r() < loss) return;
      const copies = r() < dup ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        const b = bytes.slice();
        if (tamper.next) {
          b[b.length - 1] ^= 1;
          tamper.next = false;
        }
        queue.push({ to: (1 - me) as 0 | 1, bytes: b, at: clock + 5 + Math.floor(r() * 80) });
      }
    },
    onMessage: (h) => {
      handlers[me].add(h);
      return () => handlers[me].delete(h);
    },
    close: () => undefined,
  });
  const ticks: Array<() => void> = [];
  const opts = { now: () => clock, setInterval: (fn: () => void) => (ticks.push(fn), ticks.length), clearInterval: () => undefined };
  return {
    a: (secret: Uint8Array) => new DatagramLink(make(0), secret, "A", opts),
    b: (secret: Uint8Array) => new DatagramLink(make(1), secret, "B", opts),
    step(ms = 10) {
      clock += ms;
      queue.sort((x, y) => x.at - y.at);
      while (queue.length && queue[0].at <= clock) {
        const p = queue.shift()!;
        for (const h of handlers[p.to]) h(p.bytes);
      }
      if (clock % 50 === 0) for (const t of ticks) t();
    },
    queue,
    handlers,
    tamper,
  };
}

describe("П4 datagram link", () => {
  const secret = new Uint8Array(32).fill(9);

  it("delivers every message in order, both ways, over 15 % loss, duplicates and reordering", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.string({ maxLength: 300 }), fc.uint8Array({ maxLength: MAX_FRAGMENT * 5 })), { minLength: 1, maxLength: 40 }),
        fc.integer(),
        (msgs, seed) => {
          const net = lossyPair(seed, 0.15, 0.1);
          const a = net.a(secret);
          const b = net.b(secret);
          const gotB: unknown[] = [];
          const gotA: unknown[] = [];
          b.onMessage((t) => gotB.push(t));
          b.onBinary((x) => gotB.push(x));
          a.onMessage((t) => gotA.push(t));
          for (const m of msgs) {
            if (typeof m === "string") a.send(m);
            else void a.sendBinary(m);
          }
          b.send("back");
          for (let i = 0; i < 4000 && (gotB.length < msgs.length || gotA.length < 1); i++) net.step();
          expect(gotB).toEqual(msgs);
          expect(gotA).toEqual(["back"]);
          a.close();
          b.close();
        },
      ),
      { numRuns: Math.min(RUNS, 40) },
    );
  });

  it("drops forged, damaged and replayed datagrams", () => {
    const net = lossyPair(5, 0, 0);
    const a = net.a(secret);
    const b = net.b(secret);
    const got: string[] = [];
    b.onMessage((t) => got.push(t));
    // Record what A sends so it can be replayed later.
    const sentByA: Uint8Array[] = [];
    const deliverToB = (bytes: Uint8Array) => net.handlers[1].forEach((h) => h(bytes));
    a.send("one");
    for (let i = 0; i < 20; i++) {
      for (const p of net.queue) if (p.to === 1) sentByA.push(p.bytes.slice());
      net.step();
    }
    expect(got).toEqual(["one"]);
    for (const p of sentByA) deliverToB(p); // replay
    // A wrong key, and random bytes.
    const stranger = new DatagramLink({ send: deliverToB, onMessage: () => () => undefined, close: () => undefined }, new Uint8Array(32).fill(1), "A", {
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    stranger.send("forged");
    deliverToB(new Uint8Array(60).fill(0x50));
    net.tamper.next = true;
    a.send("damaged copy is dropped, the resend arrives");
    for (let i = 0; i < 200; i++) net.step();
    expect(got).toEqual(["one", "damaged copy is dropped, the resend arrives"]);
    expect(b.isOpen()).toBe(true);
  });

  it("closes both ends; the other side going quiet closes too", () => {
    const net = lossyPair(7, 0, 0);
    const a = net.a(secret);
    const b = net.b(secret);
    const reasons: string[] = [];
    b.onClose((r) => reasons.push(r));
    a.close();
    for (let i = 0; i < 10; i++) net.step();
    expect(reasons).toEqual(["closed by the other side"]);
    const net2 = lossyPair(8, 1, 0); // everything lost
    const c = net2.a(secret);
    const why: string[] = [];
    c.onClose((r) => why.push(r));
    c.send("nobody hears this");
    for (let i = 0; i < 4000 && c.isOpen(); i++) net2.step();
    expect(c.isOpen()).toBe(false);
    expect(why[0]).toMatch(/stopped answering|went quiet/);
  });

  it("back-pressure: waitForDrain waits while many frames are unacknowledged", async () => {
    const net = lossyPair(9, 0, 0);
    const a = net.a(secret);
    net.b(secret);
    let drained = false;
    void a.sendBinary(new Uint8Array(MAX_FRAGMENT * 100)).then(() => (drained = true));
    await Promise.resolve();
    expect(drained).toBe(false);
    for (let i = 0; i < 500 && !drained; i++) {
      net.step();
      await Promise.resolve();
    }
    expect(drained).toBe(true);
  });
});
