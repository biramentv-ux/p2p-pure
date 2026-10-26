/**
 * Encrypted-at-rest storage for the optional TURN settings.
 *
 * The whole record (URL, username, credential, flags) is sealed with the existing at-rest
 * primitives from src/identity/atRestCrypto.ts: AES-256-GCM, key = HKDF(history key, salt
 * "p2p-messenger/turn-config/v1"). The history key exists only in memory after unlock, so
 * while the device is locked nothing readable is on disk and nothing is in memory.
 * It lives in the existing `identity` object store under its own key; no schema change.
 */
import { STORE_IDENTITY, withStore } from "../db/database";
import { aesKeyFromPrfSecret, decryptSeed, encryptSeed } from "../identity/atRestCrypto";
import { base64UrlToBytes, bytesToBase64Url } from "./encoding";
import { parseTurnSettings, setActiveTurn, type TurnSettings } from "./turnConfig";

const ROW_KEY = "turnConfigSealed";
const SALT = new TextEncoder().encode("p2p-messenger/turn-config/v1");

interface SealedTurn {
  v: 1;
  iv: string;
  ct: string;
}

/*
 * Every write (save, delete, activate-on-unlock) runs through one promise chain, so a delete
 * can never be overtaken by a save that started earlier. `epoch` is bumped synchronously by
 * delete and lock: an operation that was already queued or running under an older epoch may
 * still finish its disk write, but it no longer switches the relay on in memory.
 */
let queue: Promise<unknown> = Promise.resolve();
let epoch = 0;

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op, op);
  queue = run.catch(() => undefined);
  return run;
}

async function writeRow(historyKey: Uint8Array, settings: TurnSettings): Promise<void> {
  const aes = aesKeyFromPrfSecret(historyKey, SALT);
  const blob = await encryptSeed(new TextEncoder().encode(JSON.stringify(settings)), aes);
  const row: SealedTurn = { v: 1, iv: bytesToBase64Url(blob.nonce), ct: bytesToBase64Url(blob.ciphertext) };
  await withStore(STORE_IDENTITY, "readwrite", (s) => {
    s.put(row, ROW_KEY);
  });
}

/**
 * Saves the settings encrypted and, if nothing cancelled it meanwhile (a delete or a lock),
 * makes them active for new connections. Returns false when it was cancelled; in that case a
 * queued delete runs right after and removes the row again.
 */
export function saveTurnSettings(historyKey: Uint8Array, settings: TurnSettings): Promise<boolean> {
  const mine = epoch;
  return serialize(async () => {
    if (mine !== epoch) return false; // a delete or lock came in before this save started
    await writeRow(historyKey, settings);
    if (mine !== epoch) return false;
    setActiveTurn(settings);
    return true;
  });
}

/** Returns null when nothing is saved or the row cannot be opened (treated as TURN off). */
export async function loadTurnSettings(historyKey: Uint8Array): Promise<TurnSettings | null> {
  const row = await withStore<SealedTurn | undefined>(STORE_IDENTITY, "readonly", (s) => s.get(ROW_KEY));
  if (!row || row.v !== 1) return null;
  try {
    const aes = aesKeyFromPrfSecret(historyKey, SALT);
    const plain = await decryptSeed({ nonce: base64UrlToBytes(row.iv), ciphertext: base64UrlToBytes(row.ct) }, aes);
    return parseTurnSettings(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    return null;
  }
}

/**
 * Deletes the saved relay. The in-memory config is dropped at once and any pending save is
 * cancelled (it can no longer reactivate the relay); the disk delete then runs after it in
 * the queue. If the delete fails the rejection reaches the caller, which must not report success.
 */
export function clearTurnSettings(): Promise<void> {
  epoch++;
  setActiveTurn(null);
  return serialize(async () => {
    setActiveTurn(null);
    await withStore(STORE_IDENTITY, "readwrite", (s) => {
      s.delete(ROW_KEY);
    });
  });
}

/** After unlock: decrypt and make the settings active for new connections. */
export function activateStoredTurn(historyKey: Uint8Array): Promise<TurnSettings | null> {
  const mine = epoch;
  return serialize(async () => {
    const settings = await loadTurnSettings(historyKey);
    if (mine === epoch) setActiveTurn(settings);
    return settings;
  });
}

/** On lock: forget the credential in memory and cancel pending activations. */
export function deactivateTurn(): void {
  epoch++;
  setActiveTurn(null);
}
