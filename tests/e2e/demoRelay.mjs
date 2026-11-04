/**
 * Minimal stand-in for the Worker's demo room endpoints, for the browser test only.
 * It speaks the same protocol as worker/index.ts (POST /ws/rooms, GET /ws/rooms/:code
 * upgrade) and uses the same RoomRelay (worker/room.ts) and code generator (worker/logic.ts),
 * loaded through Vite so the code under test is the real code. Text frames only.
 */
import http from "node:http";
import crypto from "node:crypto";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
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

/**
 * Starts the relay on a free local port. `vite` is the running Vite dev server, used to load
 * the Worker's own modules. Returns the base URL and the list of relayed text frames.
 */
export async function startDemoRelay(vite, port = 0) {
  const { RoomRelay, ROOM_JOINED_FRAME } = await vite.ssrLoadModule("/worker/room.ts");
  const { newRoomId, normalizeRoomId } = await vite.ssrLoadModule("/worker/logic.ts");
  void ROOM_JOINED_FRAME;
  const rooms = new Map();
  const frames = [];

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === "POST" && req.url === "/ws/rooms") {
      res.writeHead(201, { ...CORS, "content-type": "application/json" });
      return res.end(JSON.stringify({ code: newRoomId(), ttlSec: 600 }));
    }
    res.writeHead(404, CORS);
    res.end();
  });

  server.on("upgrade", (req, socket) => {
    const match = /^\/ws\/rooms\/([^/]+)$/.exec(req.url ?? "");
    const code = match ? normalizeRoomId(decodeURIComponent(match[1])) : null;
    if (!code) return socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");

    let relay = rooms.get(code);
    if (!relay) {
      relay = new RoomRelay();
      rooms.set(code, relay);
    }
    if (relay.size >= 2) return socket.end("HTTP/1.1 409 Conflict\r\n\r\n");

    const accept = crypto
      .createHash("sha1")
      .update(String(req.headers["sec-websocket-key"]) + WS_GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const peer = {
      send: (text) => socket.write(frame(0x1, Buffer.from(text, "utf8"))),
      close: (closeCode, reason) => {
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(closeCode, 0);
        body.write(reason, 2);
        socket.end(frame(0x8, body));
      },
    };
    relay.join(peer);

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const f = parseFrame(buffer);
        if (!f) break;
        buffer = buffer.subarray(f.size);
        if (f.opcode === 0x8) {
          relay.leave(peer);
          return socket.end();
        }
        if (f.opcode === 0x9) socket.write(frame(0xa, f.payload));
        if (f.opcode === 0x1) {
          const text = f.payload.toString("utf8");
          frames.push(text);
          relay.relay(peer, text);
        }
      }
    });
    socket.on("close", () => relay.leave(peer));
    socket.on("error", () => relay.leave(peer));
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = server.address().port;
  return {
    url: `http://127.0.0.1:${bound}`,
    frames,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
