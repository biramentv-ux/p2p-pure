/**
 * Н8 NAT lab: the smallest STUN server that WebRTC needs (RFC 5389 Binding only). It answers
 * every Binding request with the address it came from (XOR-MAPPED-ADDRESS), over UDP4 and UDP6.
 * No TURN, no auth, no state. Runs inside the lab's "wan" namespace; never on the internet.
 *
 *   node scripts/natlab/stun.mjs --host 203.0.113.1 --port 3478 [--host6 2001:db8:ffff::1]
 */
import dgram from "node:dgram";

export const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_SOFTWARE = 0x8022;

/** Parses a STUN message header. Returns null for anything that is not a STUN Binding request. */
export function parseBindingRequest(msg) {
  if (!(msg instanceof Uint8Array) || msg.length < 20) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const type = view.getUint16(0);
  const length = view.getUint16(2);
  if ((msg[0] & 0xc0) !== 0) return null; // the two top bits of every STUN message are zero
  if (type !== BINDING_REQUEST) return null;
  if (view.getUint32(4) !== MAGIC_COOKIE) return null;
  if (length % 4 !== 0 || 20 + length !== msg.length) return null;
  return { transactionId: msg.slice(8, 20) };
}

function ipv4Bytes(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`bad IPv4 ${address}`);
  return Uint8Array.from(parts);
}

function ipv6Bytes(address) {
  let a = address.toLowerCase();
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  // ::ffff:1.2.3.4 written by a dual-stack socket
  const v4 = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const b = ipv4Bytes(v4[2]);
    a = `${v4[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, tail] = a.includes("::") ? a.split("::") : [a, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) throw new Error(`bad IPv6 ${address}`);
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const n = parseInt(g, 16);
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
}

/** Builds the Binding success response for `rinfo` (the source address of the request). */
export function bindingResponse(transactionId, rinfo) {
  const family = rinfo.family === "IPv6" || rinfo.family === 6 ? 2 : 1;
  const addr = family === 1 ? ipv4Bytes(rinfo.address) : ipv6Bytes(rinfo.address);
  const software = new TextEncoder().encode("p2p-natlab");
  const softwarePadded = Math.ceil(software.length / 4) * 4;
  const xorLen = 4 + addr.length;
  const bodyLen = 4 + xorLen + 4 + softwarePadded;
  const out = new Uint8Array(20 + bodyLen);
  const view = new DataView(out.buffer);
  view.setUint16(0, BINDING_SUCCESS);
  view.setUint16(2, bodyLen);
  view.setUint32(4, MAGIC_COOKIE);
  out.set(transactionId, 8);
  let o = 20;
  view.setUint16(o, ATTR_XOR_MAPPED_ADDRESS);
  view.setUint16(o + 2, xorLen);
  out[o + 4] = 0;
  out[o + 5] = family;
  view.setUint16(o + 6, rinfo.port ^ (MAGIC_COOKIE >>> 16));
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, MAGIC_COOKIE);
  key.set(transactionId, 4);
  for (let i = 0; i < addr.length; i++) out[o + 8 + i] = addr[i] ^ key[i];
  o += 4 + xorLen;
  view.setUint16(o, ATTR_SOFTWARE);
  view.setUint16(o + 2, software.length);
  out.set(software, o + 4);
  return out;
}

/** Reads XOR-MAPPED-ADDRESS back (for tests and the lab's self-check). */
export function readMappedAddress(response) {
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const tid = response.slice(8, 20);
  let o = 20;
  while (o + 4 <= response.length) {
    const type = view.getUint16(o);
    const len = view.getUint16(o + 2);
    if (type === ATTR_XOR_MAPPED_ADDRESS) {
      const family = response[o + 5];
      const port = view.getUint16(o + 6) ^ (MAGIC_COOKIE >>> 16);
      const key = new Uint8Array(16);
      new DataView(key.buffer).setUint32(0, MAGIC_COOKIE);
      key.set(tid, 4);
      const n = family === 1 ? 4 : 16;
      const b = Array.from({ length: n }, (_, i) => response[o + 8 + i] ^ key[i]);
      const address =
        family === 1
          ? b.join(".")
          : Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(":");
      return { family: family === 1 ? "IPv4" : "IPv6", address, port };
    }
    o += 4 + Math.ceil(len / 4) * 4;
  }
  return null;
}

export function startStun({ host, host6, port = 3478, log = () => undefined }) {
  const sockets = [];
  for (const [type, addr] of [["udp4", host], ["udp6", host6]]) {
    if (!addr) continue;
    const sock = dgram.createSocket({ type, ipv6Only: type === "udp6" });
    sock.on("message", (msg, rinfo) => {
      const req = parseBindingRequest(new Uint8Array(msg));
      if (!req) return;
      sock.send(bindingResponse(req.transactionId, rinfo), rinfo.port, rinfo.address);
      log(`binding ${rinfo.address}:${rinfo.port}`);
    });
    sock.bind(port, addr);
    sockets.push(sock);
  }
  return { close: () => sockets.forEach((s) => s.close()) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  startStun({
    host: arg("--host"),
    host6: arg("--host6"),
    port: Number(arg("--port") ?? 3478),
    log: process.env.STUN_LOG ? (m) => console.log(m) : undefined,
  });
  console.log("stun ready");
}
