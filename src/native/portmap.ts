/**
 * П4 (experiment): asking the home router for a port mapping, so the other side can reach this
 * device directly. Three protocols, tried in this order by the native shells:
 *
 *  - PCP (RFC 6887), UDP 5351: MAP opcode. Newer routers and many carrier NATs.
 *  - NAT-PMP (RFC 6886), UDP 5351: the older Apple protocol, still common.
 *  - UPnP-IGD: SSDP discovery (UDP 239.255.255.250:1900), then SOAP AddPortMapping over HTTP.
 *
 * Only the wire formats live here (pure, tested and fuzzed). Sending them needs a UDP socket
 * and HTTP to the LAN, which only the native shells have (src/native/bridge.ts). A browser
 * cannot do any of this.
 */

export const PCP_PORT = 5351;
export const NATPMP_PORT = 5351;
export const SSDP_ADDRESS = "239.255.255.250";
export const SSDP_PORT = 1900;

export class PortMapError extends Error {
  readonly code: "malformed" | "refused" | "unsupported";
  constructor(message: string, code: "malformed" | "refused" | "unsupported") {
    super(message);
    this.name = "PortMapError";
    this.code = code;
  }
}

export interface Mapping {
  protocol: "pcp" | "natpmp" | "upnp";
  internalPort: number;
  externalPort: number;
  /** The router's public address, when the protocol says it. */
  externalAddress?: string;
  lifetimeSec: number;
}

const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

function ipv4ToBytes(ip: string): Uint8Array {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new PortMapError(`Not an IPv4 address: ${ip}`, "malformed");
  return Uint8Array.from(
    parts.map((p) => {
      const n = Number(p);
      if (!/^\d{1,3}$/.test(p) || n > 255) throw new PortMapError(`Not an IPv4 address: ${ip}`, "malformed");
      return n;
    }),
  );
}

// ---------------------------------------------------------------- NAT-PMP (RFC 6886)

/** Asks for the router's public IPv4 address. */
export function natpmpExternalAddressRequest(): Uint8Array {
  return Uint8Array.of(0, 0);
}

export function parseNatpmpExternalAddress(b: Uint8Array): string {
  if (b.length < 12 || b[0] !== 0 || b[1] !== 128) throw new PortMapError("Not a NAT-PMP address response.", "malformed");
  const result = (b[2] << 8) | b[3];
  if (result !== 0) throw new PortMapError(`NAT-PMP refused (result ${result}).`, "refused");
  return `${b[8]}.${b[9]}.${b[10]}.${b[11]}`;
}

/** A UDP mapping request. `lifetimeSec` 0 removes the mapping. */
export function natpmpMapRequest(internalPort: number, suggestedExternalPort: number, lifetimeSec: number): Uint8Array {
  if (!validPort(internalPort) || !(suggestedExternalPort === 0 || validPort(suggestedExternalPort))) {
    throw new PortMapError("Bad port.", "malformed");
  }
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  b[0] = 0;
  b[1] = 1; // UDP
  v.setUint16(4, internalPort);
  v.setUint16(6, suggestedExternalPort);
  v.setUint32(8, Math.max(0, Math.floor(lifetimeSec)) >>> 0);
  return b;
}

export function parseNatpmpMapResponse(b: Uint8Array): Mapping {
  if (b.length < 16 || b[0] !== 0 || b[1] !== 129) throw new PortMapError("Not a NAT-PMP UDP mapping response.", "malformed");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const result = v.getUint16(2);
  if (result !== 0) throw new PortMapError(`NAT-PMP refused the mapping (result ${result}).`, "refused");
  const internalPort = v.getUint16(8);
  const externalPort = v.getUint16(10);
  if (!validPort(internalPort) || !validPort(externalPort)) throw new PortMapError("NAT-PMP gave port 0.", "malformed");
  return { protocol: "natpmp", internalPort, externalPort, lifetimeSec: v.getUint32(12) };
}

// ---------------------------------------------------------------- PCP (RFC 6887)

const PCP_VERSION = 2;
const PCP_OP_MAP = 1;
const PCP_HEADER = 24;
const PCP_MAP_DATA = 36;
const PROTO_UDP = 17;

/** An IPv4 address as PCP writes it: the IPv4-mapped IPv6 form ::ffff:a.b.c.d. */
function mappedV4(ip: string): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  out.set(ipv4ToBytes(ip), 12);
  return out;
}

function formatPcpAddress(b: Uint8Array): string {
  const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return groups.join(":");
}

/**
 * A PCP MAP request for UDP. `nonce` (12 random bytes) ties the answer to the request;
 * `clientIp` is this device's LAN address (PCP needs it to detect a NAT in between).
 */
export function pcpMapRequest(args: { clientIp: string; internalPort: number; suggestedExternalPort?: number; lifetimeSec: number; nonce: Uint8Array }): Uint8Array {
  const { clientIp, internalPort, suggestedExternalPort = 0, lifetimeSec, nonce } = args;
  if (nonce.length !== 12) throw new PortMapError("PCP nonce must be 12 bytes.", "malformed");
  if (!validPort(internalPort) || !(suggestedExternalPort === 0 || validPort(suggestedExternalPort))) {
    throw new PortMapError("Bad port.", "malformed");
  }
  const b = new Uint8Array(PCP_HEADER + PCP_MAP_DATA);
  const v = new DataView(b.buffer);
  b[0] = PCP_VERSION;
  b[1] = PCP_OP_MAP; // R bit 0: request
  v.setUint32(4, Math.max(0, Math.floor(lifetimeSec)) >>> 0);
  b.set(mappedV4(clientIp), 8);
  const o = PCP_HEADER;
  b.set(nonce, o);
  b[o + 12] = PROTO_UDP;
  v.setUint16(o + 16, internalPort);
  v.setUint16(o + 18, suggestedExternalPort);
  // Suggested external address: all zeros IPv4-mapped (::ffff:0.0.0.0) = "any IPv4".
  b[o + 30] = 0xff;
  b[o + 31] = 0xff;
  return b;
}

const PCP_RESULTS: Record<number, string> = {
  1: "UNSUPP_VERSION",
  2: "NOT_AUTHORIZED",
  3: "MALFORMED_REQUEST",
  4: "UNSUPP_OPCODE",
  5: "UNSUPP_OPTION",
  6: "MALFORMED_OPTION",
  7: "NETWORK_FAILURE",
  8: "NO_RESOURCES",
  9: "UNSUPP_PROTOCOL",
  10: "USER_EX_QUOTA",
  11: "CANNOT_PROVIDE_EXTERNAL",
  12: "ADDRESS_MISMATCH",
  13: "EXCESSIVE_REMOTE_PEERS",
};

export function parsePcpMapResponse(b: Uint8Array, nonce: Uint8Array): Mapping {
  if (b.length < PCP_HEADER + PCP_MAP_DATA) throw new PortMapError("PCP response too short.", "malformed");
  if (b[0] !== PCP_VERSION) {
    // A NAT-PMP-only router answers a PCP request with version 0 (RFC 6887 §9).
    throw new PortMapError("The router speaks NAT-PMP, not PCP.", "unsupported");
  }
  if (b[1] !== (0x80 | PCP_OP_MAP)) throw new PortMapError("Not a PCP MAP response.", "malformed");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const result = b[3];
  if (result !== 0) throw new PortMapError(`PCP refused: ${PCP_RESULTS[result] ?? result}.`, result === 1 ? "unsupported" : "refused");
  const o = PCP_HEADER;
  for (let i = 0; i < 12; i++) if (b[o + i] !== nonce[i]) throw new PortMapError("PCP answer for another request.", "malformed");
  if (b[o + 12] !== PROTO_UDP) throw new PortMapError("PCP mapped another protocol.", "malformed");
  const internalPort = v.getUint16(o + 16);
  const externalPort = v.getUint16(o + 18);
  if (!validPort(internalPort) || !validPort(externalPort)) throw new PortMapError("PCP gave port 0.", "malformed");
  return {
    protocol: "pcp",
    internalPort,
    externalPort,
    externalAddress: formatPcpAddress(b.subarray(o + 20, o + 36)),
    lifetimeSec: v.getUint32(4),
  };
}

// ---------------------------------------------------------------- UPnP-IGD

export function ssdpSearch(mx = 2): string {
  return [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${Math.min(5, Math.max(1, Math.floor(mx)))}`,
    "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
    "",
    "",
  ].join("\r\n");
}

/**
 * The device description URL from an SSDP answer. Only http:// on a private LAN address is
 * accepted: a hostile device on the network must not make us fetch anything else.
 */
export function parseSsdpLocation(text: string): string | null {
  if (!/^HTTP\/1\.1 200/i.test(text)) return null;
  const m = text.match(/^location:\s*(\S+)\s*$/im);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[1]);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !isPrivateV4(url.hostname)) return null;
  return url.toString();
}

export function isPrivateV4(host: string): boolean {
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(host);
}

/**
 * From the device description XML: the control URL and service type of the WAN connection
 * service (WANIPConnection, else WANPPPConnection), resolved against the description's URL
 * and kept on the same host.
 */
export function parseIgdDescription(xml: string, baseUrl: string): { controlUrl: string; serviceType: string } | null {
  const services = xml.match(/<service>[\s\S]*?<\/service>/gi) ?? [];
  const pick = (kind: string) =>
    services
      .map((s) => ({
        type: s.match(/<serviceType>\s*([^<]+?)\s*<\/serviceType>/i)?.[1] ?? "",
        control: s.match(/<controlURL>\s*([^<]+?)\s*<\/controlURL>/i)?.[1] ?? "",
      }))
      .find((s) => s.type.includes(`:service:${kind}:`) && s.control);
  const found = pick("WANIPConnection") ?? pick("WANPPPConnection");
  if (!found) return null;
  let url: URL;
  try {
    url = new URL(found.control, baseUrl);
  } catch {
    return null;
  }
  if (url.host !== new URL(baseUrl).host || url.protocol !== "http:") return null;
  return { controlUrl: url.toString(), serviceType: found.type };
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function upnpAddPortMapping(args: { serviceType: string; externalPort: number; internalPort: number; internalClient: string; lifetimeSec: number; description?: string }): {
  soapAction: string;
  body: string;
} {
  const { serviceType, externalPort, internalPort, internalClient, lifetimeSec } = args;
  if (!validPort(externalPort) || !validPort(internalPort)) throw new PortMapError("Bad port.", "malformed");
  if (!isPrivateV4(internalClient)) throw new PortMapError("Internal client must be a LAN address.", "malformed");
  const description = xmlEscape((args.description ?? "P2P Messenger").slice(0, 60));
  return {
    soapAction: `"${serviceType}#AddPortMapping"`,
    body:
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:AddPortMapping xmlns:u="${xmlEscape(serviceType)}"><NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort>` +
      `<NewProtocol>UDP</NewProtocol><NewInternalPort>${internalPort}</NewInternalPort><NewInternalClient>${internalClient}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled><NewPortMappingDescription>${description}</NewPortMappingDescription><NewLeaseDuration>${Math.max(0, Math.floor(lifetimeSec))}</NewLeaseDuration>` +
      `</u:AddPortMapping></s:Body></s:Envelope>`,
  };
}

export function upnpDeletePortMapping(serviceType: string, externalPort: number): { soapAction: string; body: string } {
  if (!validPort(externalPort)) throw new PortMapError("Bad port.", "malformed");
  return {
    soapAction: `"${serviceType}#DeletePortMapping"`,
    body:
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:DeletePortMapping xmlns:u="${xmlEscape(serviceType)}"><NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort><NewProtocol>UDP</NewProtocol></u:DeletePortMapping></s:Body></s:Envelope>`,
  };
}

export function upnpGetExternalIp(serviceType: string): { soapAction: string; body: string } {
  return {
    soapAction: `"${serviceType}#GetExternalIPAddress"`,
    body:
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>` +
      `<u:GetExternalIPAddress xmlns:u="${xmlEscape(serviceType)}"></u:GetExternalIPAddress></s:Body></s:Envelope>`,
  };
}

/** A SOAP answer: ok, or the UPnP error code (e.g. 718 ConflictInMappingEntry). */
export function parseSoapResult(status: number, xml: string): { ok: true; externalIp?: string } | { ok: false; code: number } {
  if (status === 200 && !/<(\w+:)?Fault>/i.test(xml)) {
    const ip = xml.match(/<NewExternalIPAddress>\s*([\d.]+)\s*<\/NewExternalIPAddress>/i)?.[1];
    return ip ? { ok: true, externalIp: ip } : { ok: true };
  }
  const code = Number(xml.match(/<errorCode>\s*(\d+)\s*<\/errorCode>/i)?.[1] ?? status);
  return { ok: false, code: Number.isFinite(code) ? code : status };
}
