/**
 * New device: turns a received bundle into a stored identity, in three steps that can be
 * retried one by one. Storing and acknowledging are kept apart: if the channel closes after
 * the identity was written, a retry must not import again (that would hit ALREADY_EXISTS with
 * the seed already zeroed). The caller keeps the returned progress and passes it back.
 */
import { importSeedAsIdentity } from "../identity/seedTransfer";
import type { CreateIdentityOptions } from "../identity/identityService";
import type { UnlockedIdentity } from "../identity/types";
import { deriveHistoryKey } from "../history/messageStore";
import { saveContact, unlockContacts } from "../contacts/contacts";
import type { TransferBundle } from "./bundle";

export interface ReceiveProgress {
  /** Set once the seed is stored on this device. From then on it is never imported again. */
  identity: UnlockedIdentity | null;
  contactsSaved: boolean;
}

export interface ReceiveResult {
  identity: UnlockedIdentity;
  /** False: stored here, but the old device did not get the confirmation (do not wipe it). */
  acknowledged: boolean;
}

export function newReceiveProgress(): ReceiveProgress {
  return { identity: null, contactsSaved: false };
}

/**
 * Imports (once), writes the contacts (idempotent), then reports `stored` to the old device.
 * Throws only while nothing usable is stored yet; once the identity exists, an acknowledgement
 * failure is returned as `acknowledged: false` instead.
 */
export async function completeReceive(
  bundle: TransferBundle,
  progress: ReceiveProgress,
  ack: (did: string) => Promise<void>,
  password?: string,
  options: CreateIdentityOptions = {},
): Promise<ReceiveResult> {
  if (!progress.identity) {
    progress.identity = await importSeedAsIdentity(bundle.seed, password, options);
    bundle.seed.fill(0);
  }
  const identity = progress.identity;
  if (!progress.contactsSaved) {
    await unlockContacts(deriveHistoryKey(identity));
    for (const c of bundle.contacts) await saveContact(c);
    progress.contactsSaved = true;
  }
  try {
    await ack(identity.did);
    return { identity, acknowledged: true };
  } catch {
    return { identity, acknowledged: false };
  }
}
