/**
 * Orchestrates identity creation, unlock, and recovery.
 *
 * Flow A — create (new user, new device):
 *   1. generate BIP39 mnemonic -> seed -> deterministic Ed25519 keypair -> did:key
 *   2. create passkey, try to get a PRF secret
 *   3. encrypt the seed with a key derived from (PRF secret, else password)
 *   4. persist { did, publicKey, encryptedSeed, nonce, unlockMethod, ... } to IndexedDB
 *   5. return the mnemonic to the caller ONCE, for the user to write down —
 *      it is never stored.
 *
 * Flow B — unlock (returning user, same device):
 *   1. load the IdentityRecord from IndexedDB
 *   2. get the passkey assertion for the stored credentialId, re-evaluate PRF
 *      (or prompt for the password) to reproduce the AES key
 *   3. decrypt the seed, re-derive the keypair
 *
 * Flow C — recover (new device, has the 12 words):
 *   1. user enters the mnemonic -> seed -> deterministic keypair -> same did:key
 *   2. create a NEW local passkey for this device to gate future unlocks
 *   3. encrypt + persist as in Flow A, skipping mnemonic generation
 */
import { generateMnemonic12, mnemonicToSeed, isValidMnemonic } from "./mnemonic";
import { deriveIdentityKeyPair } from "./keypair";
import { publicKeyToDidKey } from "./didKey";
import { createPasskey, getPasskey, credentialIdToBase64Url, base64UrlToCredentialId, isWebAuthnSupported } from "./webauthn";
import { aesKeyFromPrfSecret, aesKeyFromPassword, encryptSeed, decryptSeed } from "./atRestCrypto";
import { saveIdentityRecord, loadIdentityRecord, clearIdentityRecord } from "./storage";
import {
  IdentityError,
  type IdentityRecord,
  type UnlockMethod,
  type UnlockedIdentity,
} from "./types";

export interface CreateIdentityResult {
  identity: UnlockedIdentity;
  /** Shown to the user exactly once; caller is responsible for display/confirmation UX. */
  mnemonic: string;
  /** True if the device's authenticator supported PRF; false means password fallback was used. */
  usedPrf: boolean;
}

/**
 * Creates a brand-new identity: fresh mnemonic, fresh keypair, fresh passkey.
 * If the authenticator doesn't support PRF, `password` must be supplied by
 * the caller (e.g. after the UI detects usedPrf would be false) — for this
 * first pass we accept an optional password up front and only use it if
 * PRF is unavailable.
 */
export async function createIdentity(
  passwordFallback?: string,
): Promise<CreateIdentityResult> {
  const existing = await loadIdentityRecord();
  if (existing) {
    throw new IdentityError("An identity already exists on this device.", "ALREADY_EXISTS");
  }

  const mnemonic = generateMnemonic12();
  const seed = mnemonicToSeed(mnemonic);
  const keyPair = deriveIdentityKeyPair(seed);
  const did = publicKeyToDidKey(keyPair.publicKey);

  const { record } = await encryptAndPersistSeed(seed, did, keyPair.publicKey, passwordFallback);

  return {
    identity: { did, keyPair },
    mnemonic,
    usedPrf: record.unlockMethod === "webauthn-prf",
  };
}

/**
 * Recovers an identity from an existing 12-word mnemonic on a new device.
 * Registers a fresh local passkey to gate future unlocks on this device.
 */
export async function recoverIdentity(
  mnemonic: string,
  passwordFallback?: string,
): Promise<CreateIdentityResult> {
  if (!isValidMnemonic(mnemonic)) {
    throw new IdentityError("Invalid recovery phrase.", "INVALID_MNEMONIC");
  }
  const existing = await loadIdentityRecord();
  if (existing) {
    throw new IdentityError("An identity already exists on this device.", "ALREADY_EXISTS");
  }

  const seed = mnemonicToSeed(mnemonic);
  const keyPair = deriveIdentityKeyPair(seed);
  const did = publicKeyToDidKey(keyPair.publicKey);

  const { record } = await encryptAndPersistSeed(seed, did, keyPair.publicKey, passwordFallback);

  return {
    identity: { did, keyPair },
    mnemonic,
    usedPrf: record.unlockMethod === "webauthn-prf",
  };
}

async function encryptAndPersistSeed(
  seed: Uint8Array,
  did: string,
  publicKey: Uint8Array,
  passwordFallback?: string,
): Promise<{ record: IdentityRecord }> {
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  let unlockMethod: IdentityRecord["unlockMethod"];
  let credentialId: string | undefined;
  let aesKey: Uint8Array;

  if (isWebAuthnSupported()) {
    const created = await createPasskey(did);
    if (created.prfSecret) {
      aesKey = aesKeyFromPrfSecret(created.prfSecret, kdfSalt);
      unlockMethod = "webauthn-prf";
      credentialId = credentialIdToBase64Url(created.credentialId);
    } else if (passwordFallback) {
      aesKey = await aesKeyFromPassword(passwordFallback, kdfSalt);
      unlockMethod = "password";
      credentialId = credentialIdToBase64Url(created.credentialId);
    } else {
      throw new IdentityError(
        "This authenticator doesn't support PRF; a password is required.",
        "PRF_UNSUPPORTED",
      );
    }
  } else if (passwordFallback) {
    aesKey = await aesKeyFromPassword(passwordFallback, kdfSalt);
    unlockMethod = "password";
  } else {
    throw new IdentityError(
      "WebAuthn is unavailable and no password fallback was provided.",
      "WEBAUTHN_UNSUPPORTED",
    );
  }

  const { ciphertext, nonce } = await encryptSeed(seed, aesKey);

  const record: IdentityRecord = {
    did,
    publicKey,
    encryptedSeed: ciphertext,
    nonce,
    unlockMethod,
    credentialId,
    kdfSalt,
    createdAt: Date.now(),
  };
  await saveIdentityRecord(record);
  return { record };
}

/**
 * Unlocks the existing on-device identity: re-authenticates with the
 * passkey (or password) and decrypts the seed to re-derive the keypair.
 */
export async function unlockIdentity(password?: string): Promise<UnlockedIdentity> {
  const record = await loadIdentityRecord();
  if (!record) {
    throw new IdentityError("No identity exists on this device yet.", "NO_IDENTITY");
  }

  let aesKey: Uint8Array;
  if (record.unlockMethod === "webauthn-prf") {
    const credentialId = record.credentialId
      ? base64UrlToCredentialId(record.credentialId)
      : undefined;
    const assertion = await getPasskey(credentialId);
    if (!assertion.prfSecret) {
      throw new IdentityError(
        "Passkey did not return a PRF secret during unlock.",
        "PRF_UNSUPPORTED",
      );
    }
    aesKey = aesKeyFromPrfSecret(assertion.prfSecret, record.kdfSalt);
  } else {
    if (!password) {
      throw new IdentityError("Password required to unlock this identity.", "DECRYPTION_FAILED");
    }
    aesKey = await aesKeyFromPassword(password, record.kdfSalt);
  }

  const seed = await decryptSeed({ ciphertext: record.encryptedSeed, nonce: record.nonce }, aesKey);
  const keyPair = deriveIdentityKeyPair(seed);
  return { did: record.did, keyPair };
}

/** Which secret protects the local seed, so the UI knows whether to ask for a password. */
export async function getUnlockMethod(): Promise<UnlockMethod | null> {
  const record = await loadIdentityRecord();
  return record?.unlockMethod ?? null;
}

export async function hasExistingIdentity(): Promise<boolean> {
  return (await loadIdentityRecord()) !== null;
}

export async function getStoredDid(): Promise<string | null> {
  const record = await loadIdentityRecord();
  return record?.did ?? null;
}

/** Danger: wipes the local identity record. Does not affect the mnemonic/recovery. */
export async function deleteLocalIdentity(): Promise<void> {
  await clearIdentityRecord();
}
