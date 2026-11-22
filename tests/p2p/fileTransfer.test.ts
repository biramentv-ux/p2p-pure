import { describe, it, expect, vi } from "vitest";
import {
  CHUNK_BYTES,
  DOWNLOAD_MIME,
  FileResumeStore,
  FileTransferError,
  FileTransfers,
  RESUME_TTL_MS,
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

/**
 * Waits for `done` (up to 5 s; decryption and SHA-256 are slow on a loaded CI runner), then 20 ms
 * more so that nothing unexpected arrives right after. Without `done`, only the 20 ms.
 */
async function settle(done?: () => boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (done && !done() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 20));
}

describe("file transfer", () => {
  it("delivers a multi-chunk file byte for byte", async () => {
    const data = bytes(CHUNK_BYTES * 3 + 123);
    const { a, log } = pair();
    const meta = await a.send(new Blob([data as BlobPart]), "отчет.pdf");
    await settle(() => log.received.length === 1 && log.sent.length === 1);
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
    await settle(() => log.offered.length === 1);
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
    await settle(() => events.failed.mock.calls.length > 0);
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
    await settle(() => log.failed.some((f) => f.dir === "b:in"));
    expect(log.received).toHaveLength(0);
    expect(log.failed.some((f) => f.dir === "b:in")).toBe(true);
  });

  it("a dropped chunk fails the file (strict order)", async () => {
    const { a, log } = pair({ tamper: (b, i) => (i === 1 ? null : b) });
    await a.send(new Blob([bytes(CHUNK_BYTES * 3) as BlobPart]), "x.bin").catch(() => undefined);
    await settle(() => log.failed.some((f) => f.dir === "b:in"));
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
    await settle(() => log.received.length > 0);
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

describe("file transfer resume", () => {
  /** Two sides with resume options; the link can be cut and a new pair of instances made. */
  function resumable(store: { a: FileResumeStore; b: FileResumeStore }) {
    const log = { received: [] as Blob[], sent: [] as FileMeta[], paused: [] as string[], resumed: [] as string[], failed: [] as string[] };
    let cutAfter = Infinity;
    let chunks = 0;
    function link() {
      let a!: FileTransfers;
      let b!: FileTransfers;
      let up = true;
      const ev = (side: string): FileEvents => ({
        offered: (m) => void b.accept(m.id),
        progress: () => undefined,
        received: (_m, blob) => log.received.push(blob),
        sent: (m) => log.sent.push(m),
        failed: (_id, reason) => log.failed.push(`${side}:${reason}`),
        paused: (_m, _d, dir) => log.paused.push(`${side}:${dir}`),
        resumed: (_m, _d, dir) => log.resumed.push(`${side}:${dir}`),
      });
      a = new FileTransfers(
        {
          sendControl: async (t) => {
            if (!up) throw new Error("closed");
            b.handleControl(t);
          },
          sendBinary: async (bytes) => {
            if (!up) throw new Error("closed");
            if (chunks++ >= cutAfter) {
              up = false;
              throw new Error("closed");
            }
            b.handleBinary(bytes);
          },
        },
        ev("a"),
        undefined,
        { store: store.a, peer: "did:key:b" },
      );
      b = new FileTransfers(
        {
          sendControl: async (t) => {
            if (!up) throw new Error("closed");
            a.handleControl(t);
          },
          sendBinary: async () => undefined,
        },
        ev("b"),
        undefined,
        { store: store.b, peer: "did:key:a" },
      );
      return { a, b, cut: () => ((up = false), a.close(), b.close()) };
    }
    return { log, link, cutAt: (n: number) => (cutAfter = n) };
  }

  it("a dropped link pauses the file and the next link finishes it byte for byte", async () => {
    const data = bytes(CHUNK_BYTES * 5 + 77);
    const stores = { a: new FileResumeStore(), b: new FileResumeStore() };
    const r = resumable(stores);
    r.cutAt(2);
    const first = r.link();
    const err = await first.a.send(new Blob([data as BlobPart]), "видео.mp4").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileTransferError);
    expect((err as FileTransferError).paused).toBe(true);
    first.cut();
    expect(r.log.paused.sort()).toEqual(["a:out", "b:in"]);
    expect(r.log.failed).toEqual([]);
    expect(stores.a.count("did:key:b")).toBe(1);
    expect(stores.b.count("did:key:a")).toBe(1);

    r.cutAt(Infinity);
    const second = r.link();
    await second.a.resume();
    await second.b.resume();
    await settle(() => r.log.received.length === 1 && r.log.resumed.length === 2);
    expect(r.log.resumed.sort()).toEqual(["a:out", "b:in"]);
    expect(r.log.received).toHaveLength(1);
    expect(new Uint8Array(await r.log.received[0].arrayBuffer())).toEqual(data);
    expect(r.log.sent).toHaveLength(1);
    expect(stores.a.count("did:key:b")).toBe(0);
  });

  it("a resume request for a file the sender no longer has ends it on the receiver", async () => {
    const stores = { a: new FileResumeStore(), b: new FileResumeStore() };
    const r = resumable(stores);
    r.cutAt(1);
    const first = r.link();
    await first.a.send(new Blob([bytes(CHUNK_BYTES * 3) as BlobPart]), "x").catch(() => undefined);
    first.cut();
    stores.a.clear(); // the sender locked the app (or restarted)
    r.cutAt(Infinity);
    const second = r.link();
    await second.b.resume();
    await settle(() => r.log.failed.includes("b:Изпращачът спря файла."));
    expect(r.log.received).toHaveLength(0);
    expect(r.log.failed).toContain("b:Изпращачът спря файла.");
  });

  it("parked transfers expire and offers nobody accepted are not parked", async () => {
    let now = 0;
    const store = new FileResumeStore(() => now);
    const events = { offered: vi.fn(), progress: vi.fn(), received: vi.fn(), sent: vi.fn(), failed: vi.fn() };
    const f = new FileTransfers({ sendControl: async () => undefined, sendBinary: async () => undefined }, events, undefined, { store, peer: "p" });
    const offer = { id: "AAAAAAAAAAA", name: "x", size: 10, mime: DOWNLOAD_MIME, sha256: "A".repeat(43), key: "A".repeat(43), n: 1 };
    f.handleControl(`\u0001F|${JSON.stringify(offer)}`);
    f.close();
    expect(store.count("p")).toBe(0);
    expect(events.failed).toHaveBeenCalledWith("AAAAAAAAAAA", "Връзката прекъсна.", "in");

    const g = new FileTransfers({ sendControl: async () => undefined, sendBinary: async () => undefined }, events, undefined, { store, peer: "p" });
    g.handleControl(`\u0001F|${JSON.stringify(offer)}`);
    await g.accept("AAAAAAAAAAA");
    g.close();
    expect(store.count("p")).toBe(1);
    now = RESUME_TTL_MS + 1;
    expect(store.count("p")).toBe(0);
    expect(store.take("p")).toEqual({ out: [], inc: [] });
  });

  it("a bad resume index is ignored", async () => {
    const stores = { a: new FileResumeStore(), b: new FileResumeStore() };
    const r = resumable(stores);
    r.cutAt(1);
    const first = r.link();
    await first.a.send(new Blob([bytes(CHUNK_BYTES * 3) as BlobPart]), "x").catch(() => undefined);
    first.cut();
    r.cutAt(Infinity);
    const second = r.link();
    await second.a.resume();
    const id = r.log.paused.length ? stores.b.take("did:key:a").inc[0].meta.id : "";
    for (const next of [-1, 3, 1.5, "1"]) second.a.handleControl(`\u0001R|${JSON.stringify({ id, next })}`);
    await settle();
    expect(r.log.sent).toHaveLength(0);
    expect(r.log.received).toHaveLength(0);
  });
});

describe("file transfer resume: lost first frames", () => {
  it("the receiver's first request is lost; the sender's W makes it ask again, once streamed", async () => {
    const data = bytes(CHUNK_BYTES * 4 + 9);
    const sa = new FileResumeStore();
    const sb = new FileResumeStore();
    let a!: FileTransfers;
    let b!: FileTransfers;
    let up = true;
    let cut = 1;
    let dropFirstR = false;
    const got: Blob[] = [];
    const sent: string[] = [];
    const ev = (): FileEvents => ({
      offered: (m) => void b.accept(m.id),
      progress: () => undefined,
      received: (_m, blob) => void got.push(blob),
      sent: (m) => void sent.push(m.id),
      failed: () => undefined,
    });
    const make = () => {
      up = true;
      a = new FileTransfers(
        {
          sendControl: async (t) => {
            if (!up) throw new Error("closed");
            b.handleControl(t);
          },
          sendBinary: async (x) => {
            if (!up || cut-- <= 0) {
              up = false;
              throw new Error("closed");
            }
            b.handleBinary(x);
          },
        },
        ev(),
        undefined,
        { store: sa, peer: "b" },
      );
      b = new FileTransfers(
        {
          sendControl: async (t) => {
            if (!up) throw new Error("closed");
            if (dropFirstR && t.startsWith("\u0001R|")) {
              dropFirstR = false;
              return; // lost: the other chat screen was not listening yet
            }
            a.handleControl(t);
          },
          sendBinary: async () => undefined,
        },
        ev(),
        undefined,
        { store: sb, peer: "a" },
      );
    };
    make();
    await a.send(new Blob([data as BlobPart]), "x").catch(() => undefined);
    a.close();
    b.close();
    cut = Infinity;
    dropFirstR = true;
    make();
    await b.resume(); // its R is lost
    await a.resume(); // its W reaches b, which asks again
    await settle(() => got.length === 1);
    expect(got).toHaveLength(1);
    expect(new Uint8Array(await got[0].arrayBuffer())).toEqual(data);
    expect(sent).toHaveLength(1);
  });
});

describe("file frames do not collide with other frames", () => {
  it("photo, call, control and group frames are not file frames", async () => {
    const { isFileFrame } = await import("../../src/p2p/fileTransfer");
    for (const mark of ["P|", "D|", "C|", "K|", "G|", "I|"]) expect(isFileFrame(`\u0001${mark}x`), mark).toBe(false);
    for (const mark of ["F|", "A|", "X|", "R|", "W|"]) expect(isFileFrame(`\u0001${mark}x`), mark).toBe(true);
  });
});

describe("file transfer resume: review fixes", () => {
  it("a link that closes while the last chunk drains parks the file with its key intact", async () => {
    const store = new FileResumeStore();
    const events = { offered: vi.fn(), progress: vi.fn(), received: vi.fn(), sent: vi.fn(), failed: vi.fn() };
    let f!: FileTransfers;
    let chunks = 0;
    // The channel closes during the drain of the LAST chunk; the drain still resolves (as
    // PeerLink.waitForDrain does on close).
    f = new FileTransfers(
      {
        sendControl: async (t) => {
          if (t.startsWith("\u0001F|")) setTimeout(() => f.handleControl(`\u0001A|${JSON.parse(t.slice(3)).id}`), 0);
        },
        sendBinary: async () => {
          if (++chunks === 2) f.close();
        },
      },
      events,
      undefined,
      { store, peer: "p" },
    );
    const err = await f.send(new Blob([bytes(CHUNK_BYTES + 10) as BlobPart]), "x").catch((e: unknown) => e);
    expect((err as FileTransferError).paused).toBe(true);
    expect(events.sent).not.toHaveBeenCalled();
    const parked = store.take("p").out[0];
    expect(parked.next).toBe(1);
    expect(parked.key.some((b) => b !== 0)).toBe(true);
  });

  it("expire() releases entries past their time without another connection", () => {
    let now = 0;
    const store = new FileResumeStore(() => now);
    const key = new Uint8Array(32).fill(9);
    const meta = { id: "AAAAAAAAAAA", name: "x", size: 1, mime: DOWNLOAD_MIME, sha256: "" };
    store.park("p", [{ meta, rawId: new Uint8Array(8), key, blob: new Blob(["x"]), next: 0 }], []);
    now = RESUME_TTL_MS;
    store.expire();
    expect(key[0]).toBe(9);
    now = RESUME_TTL_MS + 1;
    store.expire();
    expect(key.every((b) => b === 0)).toBe(true);
    expect(store.take("p")).toEqual({ out: [], inc: [] });
  });
});

describe("file transfer resume: a link that closes during resume()", () => {
  it("parks every taken transfer again, not only those installed so far", async () => {
    const store = new FileResumeStore();
    const meta = (id: string) => ({ id, name: id, size: CHUNK_BYTES * 2, mime: DOWNLOAD_MIME, sha256: "" });
    const mk = (id: string) => ({ meta: meta(id), rawId: new Uint8Array(8), key: new Uint8Array(32).fill(1), blob: new Blob([bytes(CHUNK_BYTES * 2) as BlobPart]), next: 1 });
    store.park("p", [mk("AAAAAAAAAAA"), mk("BBBBBBBBBBB"), mk("CCCCCCCCCCC")], []);
    let f!: FileTransfers;
    const events = { offered: vi.fn(), progress: vi.fn(), received: vi.fn(), sent: vi.fn(), failed: vi.fn() };
    f = new FileTransfers(
      {
        sendControl: async () => {
          f.close(); // the new link drops while the first "W" is going out
          throw new Error("closed");
        },
        sendBinary: async () => undefined,
      },
      events,
      undefined,
      { store, peer: "p" },
    );
    await f.resume();
    expect(store.count("p")).toBe(3);
    expect(events.failed).not.toHaveBeenCalled();
  });
});
