/**
 * Seed access for the one-time device transfer (src/transfer, docs/MULTIDEVICE.md).
 *
 * `unlockSeed` is the only place where the plaintext 64-byte seed leaves the at-rest
 * encryption for a purpose other than unlocking. It re-authenticates (password or passkey), so
 * a phone left unlocked cannot be emptied without the person. `importSeedAsIdentity` is the
 * new device's side: same at-rest protection as a fresh identity (own passkey or password).
 */
import { deriveIdentityKeyPair } from "./keypair";
import { publicKeyToDidKey } from "./didKey";
import { getPasskey, base64UrlToCredentialId } from "./webauthn";
import { aesKeyFromPassword, aesKeyFromPrfSecret, decryptSeed } from "./atRestCrypto";
import { loadIdentityRecord } from "./storage";
import { encryptAndPersistSeed, type CreateIdentityOptions } from "./identityService";
import { IdentityError, type UnlockedIdentity } from "./types";

const SEED_LEN = 64;

/** Decrypts the stored seed. Caller must zero the returned array when done. */
export async function unlockSeed(password?: string): Promise<Uint8Array> {
  const record = await loadIdentityRecord();
  if (!record) throw new IdentityError("No identity exists on this device yet.", "NO_IDENTITY");
  let aesKey: Uint8Array;
  if (record.unlockMethod === "webauthn-prf") {
    const credentialId = record.credentialId ? base64UrlToCredentialId(record.credentialId) : undefined;
    const assertion = await getPasskey(credentialId);
    if (!assertion.prfSecret) {
      throw new IdentityError("Passkey did not return a PRF secret during unlock.", "PRF_UNSUPPORTED");
    }
    aesKey = aesKeyFromPrfSecret(assertion.prfSecret, record.kdfSalt);
  } else {
    if (!password) throw new IdentityError("Password required to unlock this identity.", "DECRYPTION_FAILED");
    aesKey = await aesKeyFromPassword(password, record.kdfSalt);
  }
  return decryptSeed({ ciphertext: record.encryptedSeed, nonce: record.nonce }, aesKey);
}

/**
 * Stores a seed that arrived from another device as THIS device's identity, protected by this
 * device's own unlock method. Refuses to overwrite an existing identity.
 */
export async function importSeedAsIdentity(
  seed: Uint8Array,
  passwordFallback?: string,
  options: CreateIdentityOptions = {},
): Promise<UnlockedIdentity> {
  if (seed.length !== SEED_LEN) throw new IdentityError("Invalid seed.", "INVALID_MNEMONIC");
  if (await loadIdentityRecord()) {
    throw new IdentityError("An identity already exists on this device.", "ALREADY_EXISTS");
  }
  const keyPair = deriveIdentityKeyPair(seed);
  const did = publicKeyToDidKey(keyPair.publicKey);
  await encryptAndPersistSeed(seed, did, keyPair.publicKey, passwordFallback, options);
  return { did, keyPair };
}
