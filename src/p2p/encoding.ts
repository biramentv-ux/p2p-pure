/**
 * Byte-level helpers shared by the invitation codec.
 *
 * Compression uses the browser's native CompressionStream("deflate-raw")
 * (Chrome 103+, Safari 16.4+, Firefox 113+, Node 21+). No JS deflate library.
 */
import { asBufferSource } from "../identity/bufferUtils";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function runTransform(
  input: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  maxOutputBytes: number,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const writing = writer.write(asBufferSource(input)).then(() => writer.close());
  // If decoding fails first (truncated or corrupt input) the read below throws; this keeps the
  // write side's rejection from surfacing as an unhandled rejection too.
  writing.catch(() => undefined);

  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel();
        throw new Error(`Decompressed payload exceeds ${maxOutputBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  await writing;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  return runTransform(input, new CompressionStream("deflate-raw"), Number.MAX_SAFE_INTEGER);
}

/** `maxOutputBytes` guards against decompression bombs in untrusted QR input. */
export function inflateRaw(input: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  return runTransform(input, new DecompressionStream("deflate-raw"), maxOutputBytes);
}
