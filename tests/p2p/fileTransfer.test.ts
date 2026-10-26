import { describe, it, expect, vi } from "vitest";
import {
  CHUNK_BYTES,
  DOWNLOAD_MIME,
  FileTransfers,
  cleanFileName,
  sniffInlineMime,
  type FileEvents,
  type FileMeta,
  type FileTransport,
} from "../../src/p2p/fileTransfer";

/** Two FileTransfers wired to each other in memory. `tamper` may change binary messages in flight. */
function pair(opts: { maxBytes?: number; tamper?: (b: Uint8Array, i: number) => Uint8Array | null; autoAccept?: boolean } = {}) {
  const log = { offered: [] as FileMeta[], received: [] as { meta: FileMeta; blob: Blob }[], sent: [] as FileMeta[], failed: [] as { id: string; reason: string; dir: string }[] };
  let a!: FileTransfers;
  let b!: FileTransfers;
  let chunkNo = 0;
  const events = (side: "a" | "b"): FileEvents => ({
    offered: (m) => {
      log.offered.push(m);
      if (side === "b" && opts.autoAccept !== false) void b.accept(m.id);
    },
    progress: () => undefined,
    received: (meta, blob) => log.received.push({ meta, blob }),
    sent: (m) => log.sent.push(m),
    failed: (id, reason, dir) => log.failed.push({ id, reason, dir: `${side}:${dir}` }),
  });
  const toB: FileTransport = {
    sendControl: async (t) => void b.handleControl(t),
    sendBinary: async (bytes) => {
      const msg = opts.tamper ? opts.tamper(bytes, chunkNo++) : bytes;
      if (msg) b.handleBinary(msg);
    },
  };
  const toA: FileTransport = { sendControl: async (t) => void a.handleControl(t), sendBinary: async (bytes) => void a.handleBinary(bytes) };
  a = new FileTransfers(toB, events("a"), opts.maxBytes);
  b = new FileTransfers(toA, events("b"), opts.maxBytes);
  return { a, b, log };
}

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("file transfer", () => {
  it("delivers a multi-chunk file byte for byte", async () => {
    const data = bytes(CHUNK_BYTES * 3 + 123);
    const { a, log } = pair();
    const meta = await a.send(new Blob([data as BlobPart]), "отчет.pdf");
    await settle();
    expect(log.sent.map((m) => m.id)).toEqual([meta.id]);
    expect(log.received).toHaveLength(1);
    const got = new Uint8Array(await log.received[0].blob.arrayBuffer());
    expect(got).toEqual(data);
    expect(log.received[0].meta.name).toBe("отчет.pdf");
    expect(log.received[0].meta.mime).toBe(DOWNLOAD_MIME);
  });

  it("waits for the receiver to accept, and a decline ends it on both sides", async () => {
    const { a, b, log } = pair({ autoAccept: false });
    const sending = a.send(new Blob([bytes(1000) as BlobPart]), "a.bin");
    await settle();
    expect(log.offered).toHaveLength(1);
    expect(log.received).toHaveLength(0);
    await b.cancel(log.offered[0].id);
    await expect(sending).rejects.toThrow("не беше приет");
    expect(log.failed.map((f) => f.dir).sort()).toEqual(["a:out", "b:in"]);
  });

  it("refuses a file over the limit before anything is sent", async () => {
    const { a, log } = pair({ maxBytes: 1000 });
    await expect(a.send(new Blob([bytes(1001) as BlobPart]), "big.bin")).rejects.toThrow("твърде голям");
    expect(log.offered).toHaveLength(0);
  });

  it("the receiver refuses an offer over its own limit", async () => {
    const sent: string[] = [];
    const events = { offered: vi.fn(), progress: vi.fn(), received: vi.fn(), sent: vi.fn(), failed: vi.fn() };
    const strict = new FileTransfers({ sendControl: async (t) => void sent.push(t), sendBinary: async () => undefined }, events, 500);
    expect(strict.handleControl("\u0001F|not json")).toBe(true);
    expect(events.offered).not.toHaveBeenCalled();
    const offer = { id: "AAAAAAAAAAA", name: "x", size: 600, mime: DOWNLOAD_MIME, sha256: "A".repeat(43), key: "A".repeat(43), n: 1 };
    strict.handleControl(`\u0001F|${JSON.stringify(offer)}`);
    await settle();
    expect(events.offered).not.toHaveBeenCalled();
    expect(events.failed).toHaveBeenCalledWith("AAAAAAAAAAA", expect.stringContaining("твърде голям"), "in");
    expect(sent).toEqual(["\u0001X|AAAAAAAAAAA"]);
  });

  it("a changed byte in a chunk fails the file and nothing is delivered", async () => {
    const { a, log } = pair({
      tamper: (b, i) => {
        if (i !== 1) return b;
        const c = b.slice();
        c[40] ^= 1;
        return c;
      },
    });
    await a.send(new Blob([bytes(CHUNK_BYTES * 3) as BlobPart]), "x.bin").catch(() => undefined);
    await settle();
    expect(log.received).toHaveLength(0);
    expect(log.failed.some((f) => f.dir === "b:in")).toBe(true);
  });

  it("a dropped chunk fails the file (strict order)", async () => {
    const { a, log } = pair({ tamper: (b, i) => (i === 1 ? null : b) });
    await a.send(new Blob([bytes(CHUNK_BYTES * 3) as BlobPart]), "x.bin").catch(() => undefined);
    await settle();
    expect(log.received).toHaveLength(0);
    expect(log.failed.find((f) => f.dir === "b:in")?.reason).toMatch(/ред/);
  });

  it("a chunk replayed into another position is rejected", async () => {
    let first: Uint8Array | null = null;
    const { a, log } = pair({
      tamper: (b, i) => {
        if (i === 0) first = b;
        if (i === 1 && first) {
          // Same ciphertext, but claim index 1: the header is authenticated, so this fails.
          const c = first.slice();
          new DataView(c.buffer).setUint32(9, 1, false);
          return c;
        }
        return b;
      },
    });
    await a.send(new Blob([bytes(CHUNK_BYTES * 2 + 5) as BlobPart]), "x.bin").catch(() => undefined);
    await settle();
    expect(log.received).toHaveLength(0);
  });

  it("chunks are not plaintext on the wire", async () => {
    const data = new TextEncoder().encode("тайно съдържание ".repeat(200));
    const seen: Uint8Array[] = [];
    const { a } = pair({ tamper: (b) => (seen.push(b), b) });
    await a.send(new Blob([data as BlobPart]), "t.txt");
    const wire = new TextDecoder().decode(seen[0]);
    expect(wire).not.toContain("тайно");
  });

  it("closing the link fails transfers on both ends", async () => {
    const { a, b, log } = pair({ autoAccept: false });
    const sending = a.send(new Blob([bytes(100) as BlobPart]), "x");
    await settle();
    b.close();
    a.close();
    await expect(sending).rejects.toThrow();
    expect(log.failed.length).toBeGreaterThanOrEqual(2);
  });

  it("recognises music files by their first bytes", () => {
    const head = (...bytes: number[]) => new Uint8Array([...bytes, ...new Array(16).fill(0)]);
    const text = (t: string) => [...t].map((c) => c.charCodeAt(0));
    expect(sniffInlineMime(head(...text("ID3")))).toBe("audio/mpeg");
    expect(sniffInlineMime(head(0xff, 0xfb))).toBe("audio/mpeg");
    expect(sniffInlineMime(head(0xff, 0xf1))).toBe("audio/aac");
    expect(sniffInlineMime(head(...text("OggS")))).toBe("audio/ogg");
    expect(sniffInlineMime(head(...text("fLaC")))).toBe("audio/flac");
    expect(sniffInlineMime(head(...text("RIFF"), 0, 0, 0, 0, ...text("WAVE")))).toBe("audio/wav");
    expect(sniffInlineMime(head(0, 0, 0, 0x20, ...text("ftypM4A ")))).toBe("audio/mp4");
    expect(sniffInlineMime(head(0, 0, 0, 0x20, ...text("ftypisom")))).toBe("video/mp4");
    // A JPEG starts with 0xFF 0xD8, which is not an MPEG frame sync.
    expect(sniffInlineMime(head(0xff, 0xd8, 0xff))).toBe("image/jpeg");
  });

  it("only real media is marked for inline display", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffInlineMime(gif)).toBe("image/gif");
    const html = new TextEncoder().encode("<html><script>alert(1)</script>");
    expect(sniffInlineMime(html)).toBeNull();
    const { a, log } = pair();
    await a.send(new Blob([html as BlobPart]), "page.html");
    await settle();
    expect(log.received[0].meta.mime).toBe(DOWNLOAD_MIME);
    expect(log.received[0].blob.type).toBe(DOWNLOAD_MIME);
  });

  it("file names lose folders and control characters", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\x\\снимка.jpg")).toBe("снимка.jpg");
    expect(cleanFileName("a\u0000b.txt")).toBe("ab.txt");
    expect(cleanFileName("снимка\u202egpj.exe")).toBe("снимкаgpj.exe");
    expect(cleanFileName("...")).toBe("файл");
    expect([...cleanFileName("я".repeat(500))].length).toBe(120);
  });
});
