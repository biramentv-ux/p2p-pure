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

export async function saveTurnSettings(historyKey: Uint8Array, settings: TurnSettings): Promise<void> {
  const aes = aesKeyFromPrfSecret(historyKey, SALT);
  const blob = await encryptSeed(new TextEncoder().encode(JSON.stringify(settings)), aes);
  const row: SealedTurn = { v: 1, iv: bytesToBase64Url(blob.nonce), ct: bytesToBase64Url(blob.ciphertext) };
  await withStore(STORE_IDENTITY, "readwrite", (s) => {
    s.put(row, ROW_KEY);
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

export async function clearTurnSettings(): Promise<void> {
  await withStore(STORE_IDENTITY, "readwrite", (s) => {
    s.delete(ROW_KEY);
  });
  setActiveTurn(null);
}

/** After unlock: decrypt and make the settings active for new connections. */
export async function activateStoredTurn(historyKey: Uint8Array): Promise<TurnSettings | null> {
  const settings = await loadTurnSettings(historyKey);
  setActiveTurn(settings);
  return settings;
}

/** On lock: forget the credential in memory. */
export function deactivateTurn(): void {
  setActiveTurn(null);
}
