import { describe, it, expect } from "vitest";
import {
  buildPhotoFrames,
  CHUNK_BYTES,
  FRAME_MARK,
  MAX_PHOTO_BYTES,
  PhotoReceiver,
  sanitizeText,
  sniffMime,
} from "../../src/p2p/photo";

function fakeJpeg(size: number): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31) & 0xff;
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

function receiveAll(frames: string[]) {
  const r = new PhotoReceiver();
  return frames.map((f) => r.feed(f));
}

describe("photo frames", () => {
  it("round-trips a photo whose size is not a multiple of the chunk size", () => {
    const bytes = fakeJpeg(CHUNK_BYTES * 3 + 123);
    const results = receiveAll(buildPhotoFrames(bytes, "image/jpeg"));
    const last = results[results.length - 1];
    expect(last.kind).toBe("photo");
    if (last.kind !== "photo") return;
    expect(last.size).toBe(bytes.length);
    const b64 = last.dataUrl.split(",")[1];
    expect(Uint8Array.from(Buffer.from(b64, "base64"))).toEqual(bytes);
  });

  it("round-trips an exact multiple of the chunk size and a tiny photo", () => {
    for (const size of [CHUNK_BYTES * 2, 10]) {
      const results = receiveAll(buildPhotoFrames(fakeJpeg(size), "image/jpeg"));
      expect(results[results.length - 1].kind).toBe("photo");
    }
  });

  it("keeps every frame small enough to seal as one message", () => {
    for (const f of buildPhotoFrames(fakeJpeg(CHUNK_BYTES * 5), "image/jpeg")) {
      expect(f.length).toBeLessThan(3500);
    }
  });

  it("reports progress while chunks arrive", () => {
    const results = receiveAll(buildPhotoFrames(fakeJpeg(CHUNK_BYTES * 3), "image/jpeg"));
    expect(results[0]).toEqual({ kind: "progress", received: 0, total: 3 });
    expect(results[1]).toEqual({ kind: "progress", received: 1, total: 3 });
  });

  it("passes plain text through unchanged", () => {
    expect(new PhotoReceiver().feed("здравей")).toEqual({ kind: "text", text: "здравей" });
  });

  it("refuses to build frames for oversize or non-image data", () => {
    expect(() => buildPhotoFrames(fakeJpeg(MAX_PHOTO_BYTES + 1), "image/jpeg")).toThrow();
    expect(() => buildPhotoFrames(new Uint8Array([1, 2, 3]), "image/jpeg")).toThrow();
  });
});

describe("receiver safety", () => {
  const frames = buildPhotoFrames(fakeJpeg(CHUNK_BYTES * 3), "image/jpeg");

  it("rejects chunks that arrive out of order", () => {
    const r = new PhotoReceiver();
    r.feed(frames[0]);
    expect(r.feed(frames[2]).kind).toBe("rejected");
  });

  it("rejects a chunk with a different transfer id", () => {
    const r = new PhotoReceiver();
    r.feed(frames[0]);
    const other = buildPhotoFrames(fakeJpeg(CHUNK_BYTES * 3), "image/jpeg")[1];
    expect(r.feed(other).kind).toBe("rejected");
  });

  it("rejects chunks without a header", () => {
    expect(new PhotoReceiver().feed(frames[1]).kind).toBe("rejected");
  });

  it("rejects declared sizes that are too big or inconsistent with the chunk count", () => {
    const r = new PhotoReceiver();
    expect(r.feed(`${FRAME_MARK}P|AAAAAAAAAAA|image/jpeg|${MAX_PHOTO_BYTES + 1}|9999`).kind).toBe("rejected");
    expect(r.feed(`${FRAME_MARK}P|AAAAAAAAAAA|image/jpeg|5000|1`).kind).toBe("rejected");
  });

  it("rejects unsupported formats such as SVG", () => {
    const r = new PhotoReceiver();
    expect(r.feed(`${FRAME_MARK}P|AAAAAAAAAAA|image/svg+xml|100|1`).kind).toBe("rejected");
  });

  it("rejects a final file whose bytes are not the declared image type", () => {
    const bytes = fakeJpeg(100);
    bytes[0] = 0x00;
    const id = "AAAAAAAAAAA";
    const r = new PhotoReceiver();
    r.feed(`${FRAME_MARK}P|${id}|image/jpeg|100|1`);
    const data = Buffer.from(bytes).toString("base64url");
    expect(r.feed(`${FRAME_MARK}D|${id}|0|${data}`).kind).toBe("rejected");
  });

  it("rejects a chunk of the wrong length", () => {
    const r = new PhotoReceiver();
    r.feed(frames[0]);
    const id = frames[0].split("|")[1];
    expect(r.feed(`${FRAME_MARK}D|${id}|0|${Buffer.from([1, 2, 3]).toString("base64url")}`).kind).toBe("rejected");
  });

  it("rejects unknown frame types", () => {
    expect(new PhotoReceiver().feed(`${FRAME_MARK}X|1`).kind).toBe("rejected");
  });
});

describe("helpers", () => {
  it("strips the frame marker from typed text", () => {
    expect(sanitizeText(`${FRAME_MARK}P|forged`)).toBe("P|forged");
  });

  it("recognises JPEG, PNG and WebP signatures and nothing else", () => {
    expect(sniffMime(fakeJpeg(10))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffMime(webp)).toBe("image/webp");
    expect(sniffMime(new Uint8Array([60, 115, 118, 103]))).toBeNull(); // "<svg"
  });
});
