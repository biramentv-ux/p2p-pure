import { publicKeyToDidKey } from "../../src/identity/didKey";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import type { Contact } from "../../src/contacts/contacts";
import { TransferEndpoint, type TransferChannel, type TransferState } from "../../src/transfer/endpoint";
import { newAnswer, newEphemeral, newOffer, type TransferPacket } from "../../src/transfer/packet";
import { deriveTransferKeys, type TransferKeys } from "../../src/transfer/session";

export interface Tap {
  /** Return a replacement text, or null to drop the frame. */
  (text: string, from: "a" | "b"): string | null;
}

export interface FakeChannel extends TransferChannel {
  sent: string[];
  closed: boolean;
  deliver(text: string): void;
  /** The link dies (network gone, peer closed): both ends get their close handlers. */
  kill(): void;
  fireClose(): void;
}

/** Two connected in-memory channels. Messages arrive asynchronously, in order. */
export function channelPair(tap?: Tap): { a: FakeChannel; b: FakeChannel } {
  const make = (name: "a" | "b"): FakeChannel => {
    const handlers = new Set<(t: string) => void>();
    const closeHandlers = new Set<(r: string) => void>();
    const ch: FakeChannel = {
      sent: [],
      closed: false,
      send(text) {
        ch.sent.push(text);
        const out = tap ? tap(text, name) : text;
        if (out === null) return;
        const peer = name === "a" ? pair.b : pair.a;
        queueMicrotask(() => peer.deliver(out));
      },
      onMessage(h) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      onClose(h) {
        closeHandlers.add(h);
        return () => closeHandlers.delete(h);
      },
      close() {
        ch.closed = true;
        ch.fireClose();
      },
      fireClose() {
        const hs = [...closeHandlers];
        closeHandlers.clear();
        for (const h of hs) h("closed");
      },
      kill() {
        pair.a.fireClose();
        pair.b.fireClose();
      },
      deliver(text) {
        for (const h of [...handlers]) h(text);
      },
    };
    return ch;
  };
  const pair = { a: make("a"), b: make("b") };
  return pair;
}

export function makeKeys(opts: { now?: number; sdpOffer?: string; sdpAnswer?: string } = {}) {
  const now = opts.now ?? Date.now();
  const eS = newEphemeral();
  const eR = newEphemeral();
  const offer = newOffer(opts.sdpOffer ?? "v=0 offer", eS.publicKey, now);
  const answer = newAnswer(offer, opts.sdpAnswer ?? "v=0 answer", eR.publicKey);
  return {
    offer,
    answer,
    sender: deriveTransferKeys("sender", eS.secretKey, offer, answer),
    receiver: deriveTransferKeys("receiver", eR.secretKey, offer, answer),
    eS,
    eR,
  };
}

export function sampleContacts(n = 3): Contact[] {
  return Array.from({ length: n }, (_, i) => {
    const kp = deriveIdentityKeyPair(new Uint8Array(64).fill(i + 1));
    return {
      did: publicKeyToDidKey(kp.publicKey),
      publicKey: kp.publicKey,
      name: `Контакт ${i}`,
      verified: i % 2 === 0,
      verifiedAt: i % 2 === 0 ? 1000 + i : undefined,
      addedAt: 2000 + i,
    };
  });
}

export const SEED = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

export function waitFor(ep: TransferEndpoint, ...states: TransferState[]): Promise<TransferState> {
  return new Promise((resolve) => {
    if (states.includes(ep.state)) return resolve(ep.state);
    const off = ep.onState((s) => {
      if (states.includes(s)) {
        off();
        resolve(s);
      }
    });
  });
}

export function setup(
  opts: {
    tap?: Tap;
    keys?: ReturnType<typeof makeKeys>;
    now?: () => number;
    contacts?: Contact[];
    ownDid?: string;
    getBundle?: () => Promise<{ seed: Uint8Array; contacts: Contact[] }>;
  } = {},
) {
  // The keys' deadline comes from the same clock as the endpoints: with the real Date.now()
  // a slow runner moved it past a test's "now + TTL + 1", and the expiry test flaked.
  const keys = opts.keys ?? makeKeys({ now: opts.now?.() });
  const ch = channelPair(opts.tap);
  const contacts = opts.contacts ?? sampleContacts();
  const ownDid = opts.ownDid ?? "did:key:zOwn";
  const sender = new TransferEndpoint({
    keys: keys.sender,
    channel: ch.a,
    now: opts.now,
    ownDid,
    getBundle: opts.getBundle ?? (async () => ({ seed: SEED.slice(), contacts })),
  });
  const receiver = new TransferEndpoint({ keys: keys.receiver, channel: ch.b, now: opts.now });
  return { keys, ch, sender, receiver, contacts, ownDid };
}

export type { TransferKeys, TransferPacket };
