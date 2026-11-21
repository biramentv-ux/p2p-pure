/**
 * П4 (experiment): the Electron shell's half of the native transport (src/native/bridge.ts).
 * UDP sockets, an SSDP search and HTTP to a router on the LAN, nothing else. The protocol work
 * (STUN, punching, encryption) stays in the web code. Plain Node, so it is tested without
 * Electron (tests/native/electronNet.test.ts); main.mjs wires it to the window through IPC.
 */
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";

const MAX_SOCKETS = 300; // a birthday punch opens 256
const MAX_DATAGRAM = 2048;
const PRIVATE_V4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/** The first private IPv4 address of this machine (for PCP/NAT-PMP and UPnP). */
export function lanAddress(interfaces = os.networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && PRIVATE_V4.test(a.address)) return a.address;
  }
  return undefined;
}

/** Only http:// to a private LAN address: the router, never the internet. */
export function allowedLanUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !PRIVATE_V4.test(url.hostname)) return null;
  return url;
}

/**
 * `deliver(id, bytes, host, port)` is called for every datagram that arrives.
 */
export function createNativeNet(deliver) {
  const sockets = new Map();
  let nextId = 1;

  return {
    async open() {
      if (sockets.size >= MAX_SOCKETS) throw new Error("too many sockets");
      const id = nextId++;
      const s = dgram.createSocket("udp4");
      s.on("message", (msg, rinfo) => {
        if (msg.length <= MAX_DATAGRAM) deliver(id, new Uint8Array(msg), rinfo.address, rinfo.port);
      });
      s.on("error", () => {
        sockets.delete(id);
        s.close();
      });
      await new Promise((resolve) => s.bind(0, resolve));
      sockets.set(id, s);
      return { id, port: s.address().port, lanAddress: lanAddress() };
    },

    send(id, host, port, bytes, ttl) {
      const s = sockets.get(id);
      if (!s || !(bytes instanceof Uint8Array) || bytes.length > MAX_DATAGRAM) return;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof host !== "string") return;
      if (ttl && Number.isInteger(ttl) && ttl > 0 && ttl < 64) {
        s.setTTL(ttl);
        s.send(bytes, port, host, () => {
          if (sockets.has(id)) s.setTTL(64);
        });
      } else s.send(bytes, port, host);
    },

    close(id) {
      const s = sockets.get(id);
      if (!s) return;
      sockets.delete(id);
      try {
        s.close();
      } catch {
        /* already closed */
      }
    },

    closeAll() {
      for (const id of [...sockets.keys()]) this.close(id);
    },

    /** M-SEARCH for an Internet Gateway Device; the raw answers (at most 20). */
    ssdp(timeoutMs = 1500) {
      return new Promise((resolve) => {
        const s = dgram.createSocket("udp4");
        const answers = [];
        s.on("message", (msg) => {
          if (answers.length < 20 && msg.length < 4096) answers.push(msg.toString("utf8"));
        });
        s.on("error", () => resolve(answers));
        s.bind(0, () => {
          const q = Buffer.from(
            'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n',
          );
          s.send(q, 1900, "239.255.255.250");
          setTimeout(() => {
            s.close();
            resolve(answers);
          }, Math.min(5000, Math.max(200, timeoutMs)));
        });
      });
    },

    /** GET a description or POST a SOAP call, to the LAN only; 64 KB and 3 s at most. */
    lanHttp(raw, { method = "GET", soapAction = "", body = "" } = {}) {
      const url = allowedLanUrl(raw);
      if (!url) return Promise.reject(new Error("only http to a LAN address"));
      return new Promise((resolve, reject) => {
        const req = http.request(
          url,
          {
            method: method === "POST" ? "POST" : "GET",
            timeout: 3000,
            headers: method === "POST" ? { "content-type": 'text/xml; charset="utf-8"', soapaction: soapAction, "content-length": Buffer.byteLength(body) } : {},
          },
          (res) => {
            let size = 0;
            const chunks = [];
            res.on("data", (c) => {
              size += c.length;
              if (size > 64 * 1024) {
                req.destroy();
                reject(new Error("answer too large"));
              } else chunks.push(c);
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        if (method === "POST") req.write(body);
        req.end();
      });
    },
  };
}
