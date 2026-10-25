/**
 * Bridges signed invitations and the signaling payload the provider carries.
 *
 * The invitation keeps its signature, expiry and ephemeral key; the payload only wraps it.
 * A scanned string is decoded (and its signature checked) here, before it reaches the provider.
 */
import { decodeInvitation, type Invitation } from "../p2p/invitation";
import { publicKeyToDidKey } from "../identity/didKey";
import type { SignalingPayload } from "./types";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds the payload for an invitation that has already been encoded to `encoded`. */
export function toSignalingPayload(invitation: Invitation, encoded: string): SignalingPayload {
  return {
    type: invitation.kind,
    sdp: invitation.sdp,
    did: publicKeyToDidKey(invitation.publicKey),
    nonce: toHex(invitation.nonce),
    invitation: encoded,
  };
}

/**
 * Decodes and verifies a scanned or pasted invitation, then wraps it as a payload.
 * Throws InvitationError for anything malformed, expired or with a bad signature.
 */
export async function parseScannedInvitation(
  text: string,
  now = Date.now(),
): Promise<{ invitation: Invitation; payload: SignalingPayload }> {
  const invitation = await decodeInvitation(text, now);
  return { invitation, payload: toSignalingPayload(invitation, text.trim()) };
}
