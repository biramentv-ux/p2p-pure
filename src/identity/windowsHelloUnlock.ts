/**
 * Windows Hello unlock for the desktop app (Tauri on Windows), where WebView2 gives no PRF.
 *
 * Enabling needs the password (proves the user may unlock) and adds a SECOND encrypted copy
 * of the seed; the password copy is untouched, so nothing about the password path changes.
 *
 *   credentialName = "p2p-messenger-" + hex(SHA-256(did))[0..32]
 *   challenge      = SHA-256("p2p-messenger/windows-hello/challenge/v1" || did || challengeSalt)
 *   signature      = Windows Hello RSA-2048 PKCS#1 v1.5 sign(challenge)   (deterministic)
 *   aesKey         = HKDF-SHA256(signature, kdfSalt, "p2p-messenger/windows-hello-aes/v1")
 *
 * At enrolment the challenge is signed twice and both signatures must match, so a key that
 * does not sign deterministically is refused instead of locking the user out later.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { aesKeyFromPassword, decryptSeed, encryptSeed } from "./atRestCrypto";
import { deriveIdentityKeyPair } from "./keypair";
import { loadIdentityRecord, saveIdentityRecord } from "./storage";
import { IdentityError, type IdentityRecord, type UnlockedIdentity } from "./types";
import { windowsHelloAvailable, windowsHelloSign, WindowsHelloError } from "../platform/windowsHello";

const CHALLENGE_DOMAIN = new TextEncoder().encode("p2p-messenger/windows-hello/challenge/v1");
const AES_INFO = new TextEncoder().encode("p2p-messenger/windows-hello-aes/v1");

export function windowsHelloCredentialName(did: string): string {
  return "p2p-messenger-" + bytesToHex(sha256(new TextEncoder().encode(did))).slice(0, 32);
}

export function windowsHelloChallenge(did: string, challengeSalt: Uint8Array): Uint8Array {
  const didBytes = new TextEncoder().encode(did);
  const msg = new Uint8Array(CHALLENGE_DOMAIN.length + didBytes.length + challengeSalt.length);
  msg.set(CHALLENGE_DOMAIN, 0);
  msg.set(didBytes, CHALLENGE_DOMAIN.length);
  msg.set(challengeSalt, CHALLENGE_DOMAIN.length + didBytes.length);
  return sha256(msg);
}

export function aesKeyFromWindowsHelloSignature(signature: Uint8Array, kdfSalt: Uint8Array): Uint8Array {
  return hkdf(sha256, signature, kdfSalt, AES_INFO, 32);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sign(name: string, challenge: Uint8Array, create: boolean): Promise<Uint8Array> {
  try {
    return await windowsHelloSign(name, challenge, create);
  } catch (err) {
    const reason = err instanceof WindowsHelloError ? err.reason : "error";
    throw new IdentityError(`Windows Hello failed (${reason}).`, "WINDOWS_HELLO_FAILED");
  }
}

async function requireRecord(): Promise<IdentityRecord> {
  const record = await loadIdentityRecord();
  if (!record) throw new IdentityError("No identity exists on this device yet.", "NO_IDENTITY");
  return record;
}

/** True when the record has a Hello copy and Hello can be used right now. */
export async function isWindowsHelloEnabled(): Promise<boolean> {
  const record = await loadIdentityRecord();
  return !!record?.windowsHello && (await windowsHelloAvailable());
}

/** True when Hello could be switched on: password identity, no Hello copy yet, Hello available. */
export async function canEnableWindowsHello(): Promise<boolean> {
  const record = await loadIdentityRecord();
  if (!record || record.unlockMethod !== "password" || record.windowsHello) return false;
  return windowsHelloAvailable();
}

/** Adds the Hello copy of the seed. Needs the current password; shows the Hello prompt. */
export async function enableWindowsHello(password: string): Promise<void> {
  const record = await requireRecord();
  if (record.unlockMethod !== "password") {
    throw new IdentityError("Windows Hello is only offered for password identities.", "WINDOWS_HELLO_UNAVAILABLE");
  }
  if (!(await windowsHelloAvailable())) {
    throw new IdentityError("Windows Hello is not available.", "WINDOWS_HELLO_UNAVAILABLE");
  }
  // Wrong password -> DECRYPTION_FAILED, nothing changes.
  const seed = await decryptSeed(
    { ciphertext: record.encryptedSeed, nonce: record.nonce },
    await aesKeyFromPassword(password, record.kdfSalt),
  );

  const credentialName = windowsHelloCredentialName(record.did);
  const challengeSalt = crypto.getRandomValues(new Uint8Array(32));
  const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
  const challenge = windowsHelloChallenge(record.did, challengeSalt);

  const first = await sign(credentialName, challenge, true);
  const second = await sign(credentialName, challenge, false);
  if (!sameBytes(first, second)) {
    throw new IdentityError("Windows Hello signature is not stable; not enabled.", "WINDOWS_HELLO_FAILED");
  }

  const { ciphertext, nonce } = await encryptSeed(seed, aesKeyFromWindowsHelloSignature(first, kdfSalt));
  await saveIdentityRecord({
    ...record,
    windowsHello: { credentialName, challengeSalt, kdfSalt, encryptedSeed: ciphertext, nonce, createdAt: Date.now() },
  });
}

/** Removes the Hello copy. The password copy is untouched. */
export async function disableWindowsHello(): Promise<void> {
  const record = await requireRecord();
  if (!record.windowsHello) return;
  const { windowsHello: _removed, ...rest } = record;
  void _removed;
  await saveIdentityRecord(rest);
}

/** Unlocks with Windows Hello. On any failure the caller falls back to the password. */
export async function unlockWithWindowsHello(): Promise<UnlockedIdentity> {
  const record = await requireRecord();
  const wrap = record.windowsHello;
  if (!wrap || !(await windowsHelloAvailable())) {
    throw new IdentityError("Windows Hello is not available.", "WINDOWS_HELLO_UNAVAILABLE");
  }
  const signature = await sign(wrap.credentialName, windowsHelloChallenge(record.did, wrap.challengeSalt), false);
  const seed = await decryptSeed(
    { ciphertext: wrap.encryptedSeed, nonce: wrap.nonce },
    aesKeyFromWindowsHelloSignature(signature, wrap.kdfSalt),
  );
  return { did: record.did, keyPair: deriveIdentityKeyPair(seed) };
}
