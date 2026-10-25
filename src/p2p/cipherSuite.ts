/**
 * Cipher suites for the application messages. Both are AEAD with a 256-bit key and a
 * 96-bit nonce, and both use the same Double Ratchet message keys. Only the AEAD changes.
 *
 *   aes-256-gcm        WebCrypto AES-GCM (the default, and the original format)
 *   chacha20-poly1305  @noble/ciphers ChaCha20-Poly1305 (no AES hardware needed)
 *
 * The suite is bound into the associated data through one byte, so a message encrypted
 * with one suite cannot be re-labelled as the other. The byte for AES is 'm' (0x6d),
 * the value the original format used, so existing AES messages are unchanged.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { asBufferSource } from "../identity/bufferUtils";

export type CipherSuite = "aes-256-gcm" | "chacha20-poly1305";

export const CIPHER_SUITES: readonly CipherSuite[] = ["aes-256-gcm", "chacha20-poly1305"];
export const DEFAULT_CIPHER_SUITE: CipherSuite = "aes-256-gcm";

const INFO: Record<CipherSuite, { aadByte: number; wireTag: string; label: string }> = {
  "aes-256-gcm": { aadByte: 0x6d, wireTag: "a", label: "AES-256-GCM" },
  "chacha20-poly1305": { aadByte: 0x63, wireTag: "c", label: "ChaCha20-Poly1305" },
};

export function isCipherSuite(value: unknown): value is CipherSuite {
  return typeof value === "string" && (CIPHER_SUITES as readonly string[]).includes(value);
}

export function suiteLabel(suite: CipherSuite): string {
  return INFO[suite].label;
}

export function suiteAadByte(suite: CipherSuite): number {
  return INFO[suite].aadByte;
}

/** The short value sent on the wire in the "s" field. */
export function suiteWireTag(suite: CipherSuite): string {
  return INFO[suite].wireTag;
}

export function suiteFromWireTag(tag: unknown): CipherSuite | null {
  if (typeof tag !== "string") return null;
  return CIPHER_SUITES.find((s) => INFO[s].wireTag === tag) ?? null;
}

/** AEAD encryption. The output is ciphertext with the 16-byte tag appended. */
export async function aeadSeal(
  suite: CipherSuite,
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  if (suite === "chacha20-poly1305") {
    return chacha20poly1305(key, iv, aad).encrypt(plaintext);
  }
  const cryptoKey = await crypto.subtle.importKey("raw", asBufferSource(key), "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBufferSource(iv), additionalData: asBufferSource(aad) },
    cryptoKey,
    asBufferSource(plaintext),
  );
  return new Uint8Array(ct);
}

/** AEAD decryption. Throws if the key, nonce, associated data or ciphertext is wrong. */
export async function aeadOpen(
  suite: CipherSuite,
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (suite === "chacha20-poly1305") {
    return chacha20poly1305(key, iv, aad).decrypt(ciphertext);
  }
  const cryptoKey = await crypto.subtle.importKey("raw", asBufferSource(key), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBufferSource(iv), additionalData: asBufferSource(aad) },
    cryptoKey,
    asBufferSource(ciphertext),
  );
  return new Uint8Array(pt);
}
