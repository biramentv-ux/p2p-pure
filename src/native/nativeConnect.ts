/**
 * П4 (experiment): the native transport from the connect screen's point of view.
 *
 *  1. gatherNativeEndpoint(): a UDP socket from the shell, its public endpoint and NAT kind by
 *     STUN (two servers), or a port mapping on the router (PCP, NAT-PMP, UPnP-IGD) when it
 *     gives one. Goes into the invitation as one SDP line (endpoint.ts).
 *  2. armNative(): once both endpoints are known, PeerLink gets a second way to open. When the
 *     NAT kinds say WebRTC will not get through (cone against symmetric) punching starts at
 *     once, next to WebRTC; otherwise only after WebRTC failed. Whichever opens is the link.
 *
 * Off unless the person turns on the experiment in Settings (nativeTransportEnabled) and the app
 * runs in a native shell (bridge.ts). A browser never does any of this.
 */
import { bridgeSocket, type NativeBridge } from "./bridge";
import { DatagramLink } from "./datagramLink";
import type { NativeEndpoint } from "./endpoint";
import {
  natpmpMapRequest,
  parseIgdDescription,
  parseNatpmpExternalAddress,
  parseNatpmpMapResponse,
  parsePcpMapResponse,
  parseSoapResult,
  parseSsdpLocation,
  pcpMapRequest,
  NATPMP_PORT,
  PCP_PORT,
  upnpAddPortMapping,
  upnpGetExternalIp,
  type Mapping,
  natpmpExternalAddressRequest,
} from "./portmap";
import { chooseStrategy, punch, type NatKind, type PunchSocket } from "./punch";
import { classifyNat, parseStunResponse, stunBindingRequest, type MappedAddress } from "./stun";

const SETTING_KEY = "p2p-native-transport";

export function nativeTransportEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNativeTransportEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    /* storage blocked: stays off */
  }
}

/** "stun:host:port" URLs → host/port pairs (IPv4 or names; IPv6 STUN is left to WebRTC). */
export function stunTargets(urls: string[]): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const u of urls) {
    const m = u.match(/^stuns?:([^[\]:\s]+)(?::(\d{1,5}))?$/i);
    if (m) out.push({ host: m[1], port: Number(m[2] ?? 3478) });
  }
  return out;
}

function request(sock: PunchSocket, host: string, port: number, bytes: Uint8Array, accept: (b: Uint8Array, host: string) => boolean, timeoutMs: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      off();
      clearInterval(again);
      clearTimeout(give);
      resolve(v);
    };
    const off = sock.onMessage((b, _p, h) => {
      if (accept(b, h)) finish(b);
    });
    sock.send(bytes, port, host);
    const again = setInterval(() => sock.send(bytes, port, host), 300);
    const give = setTimeout(() => finish(null), timeoutMs);
  });
}

async function stunQuery(sock: PunchSocket, target: { host: string; port: number }): Promise<MappedAddress | null> {
  const tid = crypto.getRandomValues(new Uint8Array(12));
  const res = await request(sock, target.host, target.port, stunBindingRequest(tid), (b) => parseStunResponse(b, tid) !== null, 1500);
  return res ? parseStunResponse(res, tid) : null;
}

/** Tries PCP, then NAT-PMP at the gateway, then UPnP-IGD. Null when the router offers none. */
export async function tryPortMapping(bridge: NativeBridge, sock: PunchSocket & { lanAddress?: string }, lifetimeSec = 3600): Promise<Mapping | null> {
  const lan = sock.lanAddress;
  if (!lan || !/^\d+\.\d+\.\d+\.\d+$/.test(lan)) return null;
  const gateway = lan.replace(/\.\d+$/, ".1"); // the usual home router address; others fall through to UPnP
  const fromGateway = (_b: Uint8Array, h: string) => h === gateway;
  // PCP
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const pcp = await request(sock, gateway, PCP_PORT, pcpMapRequest({ clientIp: lan, internalPort: sock.localPort, lifetimeSec, nonce }), fromGateway, 1000);
  if (pcp) {
    try {
      return parsePcpMapResponse(pcp, nonce);
    } catch {
      /* NAT-PMP-only or refused: next */
    }
  }
  // NAT-PMP
  const map = await request(sock, gateway, NATPMP_PORT, natpmpMapRequest(sock.localPort, sock.localPort, lifetimeSec), (b, h) => h === gateway && b[1] === 129, 1000);
  if (map) {
    try {
      const m = parseNatpmpMapResponse(map);
      const ext = await request(sock, gateway, NATPMP_PORT, natpmpExternalAddressRequest(), (b, h) => h === gateway && b[1] === 128, 1000);
      if (ext) m.externalAddress = parseNatpmpExternalAddress(ext);
      return m;
    } catch {
      /* refused: next */
    }
  }
  // UPnP-IGD
  try {
    for (const answer of await bridge.ssdp(1500)) {
      // The answer is checked here, in one place for every shell: http, private LAN address.
      const location = parseSsdpLocation(answer);
      if (!location) continue;
      const desc = await bridge.lanHttp(location, { method: "GET" });
      const svc = parseIgdDescription(desc.text, location);
      if (!svc) continue;
      const add = upnpAddPortMapping({ serviceType: svc.serviceType, externalPort: sock.localPort, internalPort: sock.localPort, internalClient: lan, lifetimeSec });
      const r = parseSoapResult(...(await post(bridge, svc.controlUrl, add)));
      if (!r.ok) continue;
      const ipCall = upnpGetExternalIp(svc.serviceType);
      const ip = parseSoapResult(...(await post(bridge, svc.controlUrl, ipCall)));
      return { protocol: "upnp", internalPort: sock.localPort, externalPort: sock.localPort, externalAddress: ip.ok ? ip.externalIp : undefined, lifetimeSec };
    }
  } catch {
    /* no UPnP */
  }
  return null;
}

async function post(bridge: NativeBridge, url: string, call: { soapAction: string; body: string }): Promise<[number, string]> {
  const r = await bridge.lanHttp(url, { method: "POST", soapAction: call.soapAction, body: call.body });
  return [r.status, r.text];
}

export interface GatheredEndpoint {
  endpoint: NativeEndpoint;
  socket: PunchSocket;
}

/**
 * This device's native endpoint. A router mapping wins (anyone can then reach the port: as good
 * as a cone); otherwise STUN from two servers gives the address and the NAT kind.
 */
export async function gatherNativeEndpoint(bridge: NativeBridge, stunUrls: string[], options: { portMapping?: boolean } = {}): Promise<GatheredEndpoint | null> {
  const sock = await bridgeSocket(bridge);
  const targets = stunTargets(stunUrls);
  if (targets.length === 1 && /google\.com$/.test(targets[0].host)) targets.push({ host: "stun1.l.google.com", port: 19302 });
  const first = targets[0] ? await stunQuery(sock, targets[0]) : null;
  if (!first || first.family !== "IPv4") {
    sock.close();
    return null;
  }
  const mapping = options.portMapping === false ? null : await tryPortMapping(bridge, sock).catch(() => null);
  if (mapping?.externalAddress && /^\d+\.\d+\.\d+\.\d+$/.test(mapping.externalAddress)) {
    return { socket: sock, endpoint: { host: mapping.externalAddress, port: mapping.externalPort, nat: "cone" } };
  }
  const second = targets[1] ? await stunQuery(sock, targets[1]) : null;
  const nat: NatKind = classifyNat(first, second);
  return { socket: sock, endpoint: { host: first.address, port: first.port, nat } };
}

/** True when WebRTC is expected to fail for these NAT kinds, so punching should start at once. */
export function punchInParallel(me: NatKind, peer: NatKind): boolean {
  return chooseStrategy(me, peer).startsWith("birthday");
}

/** Punches through and opens the encrypted datagram link. */
export async function connectNative(args: {
  bridge: NativeBridge;
  socket: PunchSocket;
  side: "A" | "B";
  secret: Uint8Array;
  me: NatKind;
  peer: NativeEndpoint;
  timeoutMs: number;
}): Promise<DatagramLink> {
  const p = await punch({
    side: args.side,
    secret: args.secret,
    me: args.me,
    peer: args.peer,
    socket: args.socket,
    openSocket: () => bridgeSocket(args.bridge),
    timeoutMs: args.timeoutMs,
  });
  return new DatagramLink(
    {
      send: (b) => p.socket.send(b, p.remotePort, p.remoteHost),
      onMessage: (h) =>
        p.socket.onMessage((b, port, host) => {
          if (host === p.remoteHost && port === p.remotePort) h(b);
        }),
      close: () => p.socket.close(),
    },
    args.secret,
    args.side,
  );
}
