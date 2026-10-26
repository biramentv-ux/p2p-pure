/**
 * Core identity types for the P2P messenger.
 *
 * Architecture summary (see project discussion):
 * - The user's long-term identity keypair (used for did:key and, later,
 *   as the X3DH/libsignal identity key) is derived deterministically from
 *   a BIP39 mnemonic seed — NOT from a WebAuthn passkey. WebAuthn has no
 *   API for raw ECDH/arbitrary signing, so it cannot serve as the Signal
 *   Protocol identity key.
 * - The WebAuthn passkey instead acts as a device-local "unlock" gate: it
 *   protects (encrypts) the at-rest copy of the seed in IndexedDB via the
 *   PRF extension, with a password-based fallback when PRF is unsupported.
 */

/** Raw 32-byte Ed25519 key material. */
export type Ed25519PublicKey = Uint8Array;
export type Ed25519PrivateKey = Uint8Array;

export interface Ed25519KeyPair {
  publicKey: Ed25519PublicKey;
  secretKey: Ed25519PrivateKey; // 32-byte seed (noble convention: secretKey is the seed)
}

/** A did:key string, e.g. "did:key:z6MkpzW...". */
export type DidKey = string;

/** How the at-rest seed encryption key was derived (what IdentityRecord.unlockMethod stores). */
export type StoredUnlockMethod = "webauthn-prf" | "password";

/**
 * How the UI should offer unlock. "windows-hello" is never stored as the record's method: it is
 * an extra wrap of the same seed next to the password one (see WindowsHelloWrap), offered only
 * in the Tauri desktop app on Windows when Hello is available.
 */
export type UnlockMethod = StoredUnlockMethod | "windows-hello";

/**
 * Second copy of the seed, encrypted with a key from a Windows Hello signature. The password
 * copy (encryptedSeed) stays, so the password always works and the 12 words stay the recovery.
 */
export interface WindowsHelloWrap {
  /** KeyCredentialManager credential name, "p2p-messenger-<32 hex>". */
  credentialName: string;
  /** Random salt mixed into the signed challenge. */
  challengeSalt: Uint8Array;
  /** HKDF salt for the AES key. */
  kdfSalt: Uint8Array;
  encryptedSeed: Uint8Array;
  nonce: Uint8Array;
  createdAt: number;
}

/** Non-secret identity record persisted in IndexedDB. */
export interface IdentityRecord {
  /** did:key derived from the Ed25519 public key. */
  did: DidKey;
  /** Raw public key bytes (for convenience, redundant with did). */
  publicKey: Ed25519PublicKey;
  /** Encrypted seed blob (AES-GCM), never the plaintext seed. */
  encryptedSeed: Uint8Array;
  /** AES-GCM nonce used for encryptedSeed. */
  nonce: Uint8Array;
  /** Which method protects encryptedSeed. */
  unlockMethod: StoredUnlockMethod;
  /** Optional Windows Hello copy of the seed (desktop app on Windows, password identities only). */
  windowsHello?: WindowsHelloWrap;
  /** WebAuthn credential id (base64url), when unlockMethod is webauthn-prf. */
  credentialId?: string;
  /** Salt used in the PRF evaluation / password KDF, for reproducibility. */
  kdfSalt: Uint8Array;
  createdAt: number;
}

/** In-memory, unlocked identity — never persisted as-is. */
export interface UnlockedIdentity {
  did: DidKey;
  keyPair: Ed25519KeyPair;
}

export type IdentityErrorCode =
  | "WEBAUTHN_UNSUPPORTED"
  | "PRF_UNSUPPORTED"
  | "NO_IDENTITY"
  | "ALREADY_EXISTS"
  | "DECRYPTION_FAILED"
  | "INVALID_MNEMONIC"
  | "WINDOWS_HELLO_UNAVAILABLE"
  | "WINDOWS_HELLO_FAILED";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(message: string, code: IdentityErrorCode) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}
