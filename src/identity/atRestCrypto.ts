/**
 * At-rest AES-GCM encryption for the BIP39 seed, keyed by a secret that
 * comes either from the WebAuthn PRF extension or a user password.
 * Uses the browser's native WebCrypto (SubtleCrypto) — no custom AES.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { IdentityError } from "./types";
import { asBufferSource } from "./bufferUtils";

const AES_KEY_INFO = new TextEncoder().encode("p2p-messenger/at-rest-aes-key/v1");
const PBKDF2_ITERATIONS = 600_000; // OWASP 2023+ guidance for PBKDF2-SHA256

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asBufferSource(rawKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Derives a 32-byte AES-GCM key from a WebAuthn PRF secret via HKDF. */
export function aesKeyFromPrfSecret(prfSecret: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, prfSecret, salt, AES_KEY_INFO, 32);
}

/** Derives a 32-byte AES-GCM key from a user password via PBKDF2-SHA256. */
export async function aesKeyFromPassword(
  password: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: asBufferSource(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    passwordKey,
    256,
  );
  return new Uint8Array(bits);
}

export interface EncryptedBlob {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export async function encryptSeed(seed: Uint8Array, aesKey: Uint8Array): Promise<EncryptedBlob> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(aesKey);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(nonce) },
      key,
      asBufferSource(seed),
    ),
  );
  return { ciphertext, nonce };
}

export async function decryptSeed(
  blob: EncryptedBlob,
  aesKey: Uint8Array,
): Promise<Uint8Array> {
  try {
    const key = await importAesKey(aesKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(blob.nonce) },
      key,
      asBufferSource(blob.ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new IdentityError(
      "Failed to decrypt identity seed (wrong key or corrupted data).",
      "DECRYPTION_FAILED",
    );
  }
}
