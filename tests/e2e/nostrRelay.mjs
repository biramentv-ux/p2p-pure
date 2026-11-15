/**
 * A tiny Nostr relay (NIP-01 subset) for the rendezvous browser test (Н2): REQ with
 * kinds + "#t", EVENT broadcast to matching subscriptions, OK replies. Nothing is stored,
 * like a public relay with ephemeral kinds. Records every event it saw.
 */
import http from "node:http";
import crypto from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Parses one complete client frame (masked text or control). Returns null if more bytes are needed. */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const size = offset + maskLen + len;
  if (buf.length < size) return null;
  let payload = Buffer.from(buf.subarray(offset + maskLen, size));
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, size };
}

/** Server frames are not masked. */
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}


export async function startNostrRelay(port = 0) {
  const clients = new Set();
  const events = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const accept = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const client = { subs: new Map(), send: (msg) => socket.write(frame(0x1, Buffer.from(JSON.stringify(msg), "utf8"))) };
    clients.add(client);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const f = parseFrame(buffer);
        if (!f) break;
        buffer = buffer.subarray(f.size);
        if (f.opcode === 0x8) {
          clients.delete(client);
          return socket.end();
        }
        if (f.opcode !== 0x1) continue;
        let m;
        try {
          m = JSON.parse(f.payload.toString("utf8"));
        } catch {
          continue;
        }
        if (m[0] === "REQ") {
          client.subs.set(m[1], m[2]);
          client.send(["EOSE", m[1]]);
        } else if (m[0] === "CLOSE") {
          client.subs.delete(m[1]);
        } else if (m[0] === "EVENT") {
          const ev = m[1];
          events.push(ev);
          client.send(["OK", ev.id, true, ""]);
          const t = ev.tags?.find((x) => x[0] === "t")?.[1];
          for (const c of clients) {
            for (const [sub, filter] of c.subs) {
              if (filter.kinds?.includes(ev.kind) && filter["#t"]?.includes(t)) c.send(["EVENT", sub, ev]);
            }
          }
        }
      }
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  return { url, events, close: () => new Promise((r) => { for (const c of clients) void c; server.close(() => r()); }) };
}
