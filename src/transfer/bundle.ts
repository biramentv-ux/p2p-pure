/**
 * What moves from the old device to the new one: the BIP39 seed (64 bytes) and the contact
 * book. Nothing else. Message history, files, groups and Double Ratchet state are NOT part of
 * it (see docs/MULTIDEVICE.md): the app keeps no ratchet state on disk, so there is none to
 * duplicate, and a group's keys must never exist on two devices.
 *
 * The bundle is padded to a multiple of 1 KiB before encryption so the size does not reveal
 * the exact number of contacts.
 */
import { publicKeyToDidKey } from "../identity/didKey";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import type { Contact } from "../contacts/contacts";
import { TransferError } from "./packet";

export const SEED_LEN = 64;
/** One data-channel message must stay below the ~256 KB that every browser accepts. */
export const MAX_CONTACTS = 400;
const MAX_NAME_CHARS = 200;
const PAD_BLOCK = 1024;
/**
 * The bundle is base64url-encoded inside the JSON frame, and the encrypted frame is
 * base64url-encoded again (session.ts): about 16/9 growth plus a few dozen bytes. 140 KiB
 * gives a frame of ~249 KiB, below MAX_FRAME_CHARS and the ~256 KiB a data channel message
 * may safely carry. tests/transfer/protocol.test.ts checks a bundle at this size end to end.
 */
export const MAX_BUNDLE_BYTES = 140 * 1024;

export interface TransferBundle {
  seed: Uint8Array;
  contacts: Contact[];
}

export function encodeBundle(bundle: TransferBundle): Uint8Array {
  if (bundle.seed.length !== SEED_LEN) throw new TransferError("Невалидно семе.", "BAD_BUNDLE");
  if (bundle.contacts.length > MAX_CONTACTS) {
    throw new TransferError("Твърде много контакти за прехвърляне.", "BAD_BUNDLE");
  }
  const json = JSON.stringify({
    v: 1,
    seed: bytesToBase64Url(bundle.seed),
    contacts: bundle.contacts.map((c) => ({
      did: c.did,
      pk: bytesToBase64Url(c.publicKey),
      name: c.name,
      verified: c.verified,
      verifiedAt: c.verifiedAt,
      addedAt: c.addedAt,
    })),
  });
  const body = new TextEncoder().encode(json);
  const padded = new Uint8Array(Math.ceil((4 + body.length) / PAD_BLOCK) * PAD_BLOCK);
  new DataView(padded.buffer).setUint32(0, body.length);
  padded.set(body, 4);
  if (padded.length > MAX_BUNDLE_BYTES) throw new TransferError("Пакетът е твърде голям.", "BAD_BUNDLE");
  return padded;
}

function bad(): never {
  throw new TransferError("Получените данни не са валидни.", "BAD_BUNDLE");
}

export function decodeBundle(padded: Uint8Array): TransferBundle {
  if (padded.length < 4 || padded.length > MAX_BUNDLE_BYTES) bad();
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (len > padded.length - 4) bad();
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(padded.subarray(4, 4 + len)));
  } catch {
    return bad();
  }
  if (o.v !== 1 || typeof o.seed !== "string" || !Array.isArray(o.contacts)) bad();
  if (o.contacts.length > MAX_CONTACTS) bad();
  let seed: Uint8Array;
  try {
    seed = base64UrlToBytes(o.seed);
  } catch {
    return bad();
  }
  if (seed.length !== SEED_LEN) bad();
  const seen = new Set<string>();
  const contacts: Contact[] = [];
  for (const raw of o.contacts as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") bad();
    const { did, pk, name, verified, verifiedAt, addedAt } = raw;
    if (typeof did !== "string" || typeof pk !== "string" || typeof name !== "string") bad();
    if (typeof verified !== "boolean" || typeof addedAt !== "number" || !Number.isFinite(addedAt)) bad();
    if (verifiedAt !== undefined && (typeof verifiedAt !== "number" || !Number.isFinite(verifiedAt))) bad();
    if (name.length > MAX_NAME_CHARS || seen.has(did)) bad();
    let publicKey: Uint8Array;
    try {
      publicKey = base64UrlToBytes(pk);
      // The DID must be the one this key makes: a contact cannot carry a mismatched pair.
      if (publicKey.length !== 32 || publicKeyToDidKey(publicKey) !== did) bad();
    } catch {
      return bad();
    }
    seen.add(did);
    const c: Contact = { did, publicKey, name, verified, addedAt };
    if (typeof verifiedAt === "number") c.verifiedAt = verifiedAt;
    contacts.push(c);
  }
  return { seed, contacts };
}
