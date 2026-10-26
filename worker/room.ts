/**
 * Two-peer relay for the demo WebSocket signaling mode. Pure logic, no Cloudflare types,
 * so it is tested directly. The Durable Object in index.ts wraps it.
 *
 * The relay forwards text frames between the two peers of one room and never reads them.
 * Payloads are signed invitations or signed answers; the clients verify them.
 */

/** A room lives this long after its first peer joins, then both sockets are closed. */
export const ROOM_TTL_MS = 10 * 60 * 1000;
/** Largest frame the relay forwards. A signed invitation is far below this. */
export const MAX_RELAY_CHARS = 16_384;

/** Sent to the offering peer when the second peer joins, so it knows when to send its offer. */
export const ROOM_JOINED_FRAME = '{"type":"joined"}';

export interface RoomPeer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export class RoomRelay {
  private peers: RoomPeer[] = [];

  get size(): number {
    return this.peers.length;
  }

  /** Adds a peer. A room holds exactly two; a third is refused. */
  join(peer: RoomPeer): boolean {
    if (this.peers.length >= 2) return false;
    this.peers.push(peer);
    if (this.peers.length === 2) this.peers[0].send(ROOM_JOINED_FRAME);
    return true;
  }

  /** Forwards one frame from `from` to the other peer. Oversized or lonely frames are dropped. */
  relay(from: RoomPeer, text: string): boolean {
    if (text.length > MAX_RELAY_CHARS) return false;
    const other = this.peers.find((p) => p !== from);
    if (!other) return false;
    other.send(text);
    return true;
  }

  /** A peer left: the other one is closed too, because the handshake cannot finish alone. */
  leave(peer: RoomPeer): void {
    this.peers = this.peers.filter((p) => p !== peer);
    this.closeAll("peer left");
  }

  closeAll(reason: string): void {
    const remaining = this.peers;
    this.peers = [];
    for (const p of remaining) p.close(1000, reason);
  }
}
