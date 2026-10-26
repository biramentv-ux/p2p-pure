/**
 * Connects a screen to an endpoint that may already have moved on. runEndpoint() resolves
 * after the channel opened and the hello was sent, so by then the endpoint can already be
 * `compare`, `received`, or even `failed`/`aborted` (hello send failed, channel closed).
 *
 * Order matters: the screen switches to its protocol view FIRST, then the current state is
 * replayed through the same handler as later changes. A terminal state therefore wins
 * (back to the start with the error) instead of being overwritten by the protocol view.
 */
import type { TransferEndpoint, TransferState } from "./endpoint";

export function attachEndpoint(
  endpoint: Pick<TransferEndpoint, "onState" | "state">,
  enterProtocolView: () => void,
  onState: (s: TransferState) => void,
): () => void {
  enterProtocolView();
  const off = endpoint.onState(onState);
  onState(endpoint.state);
  return off;
}
