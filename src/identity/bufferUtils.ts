/**
 * TypeScript's DOM lib types Web Crypto / WebAuthn buffer parameters as
 * `BufferSource` backed specifically by `ArrayBuffer` (not the broader
 * `ArrayBufferLike`, which also covers `SharedArrayBuffer`). Our Uint8Arrays
 * are always backed by plain ArrayBuffers at runtime, so this is a safe,
 * narrow cast point rather than a correctness workaround.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
