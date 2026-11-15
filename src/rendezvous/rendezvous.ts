/**
 * Automatic re-finding of a known contact (Н2, ADR-004, docs/PROTOCOL.md §9).
 *
 * Opt-in. While on and the app unlocked, the device listens on the rotating topics of all its
 * contacts. To reach a contact, the app publishes its signed WebRTC invitation (the same
 * `p2p1:` offer a QR carries), sealed with the pair key, under the current topic, again every
 * OFFER_REPEAT_MS. The contact's device (if listening) offers to answer; its answer comes back
 * the same way. After that the normal checks run (signature, expiry, expected contact, the
 * answer's nonce), exactly as for a scanned QR: the relays carry only ciphertext.
 *
 * If both people search at the same time, the offer of the smaller did wins and the other
 * device answers it instead of offering.
 */
import type { NostrEvent, NostrFilter } from "./nostr";
import { RENDEZVOUS_KIND, signEvent, topicOf } from "./nostr";
import { EPOCH_MS, epochOf, listenTopics, openFor, pairKey, sealFor, topicFor } from "./topic";

export const OFFER_REPEAT_MS = 30_000;
export const CALL_MAX_MS = 10 * 60_000;
export const ANSWER_REPEAT_MS = 10_000;
export const ANSWER_MAX_MS = 60_000;
/** How long back a subscription asks for (relays may still hold a recent ephemeral event). */
const SINCE_S = 60;
const MAX_INVITE_CHARS = 20_000;
const MAX_SEEN = 500;

export interface RvContact {
  did: string;
  publicKey: Uint8Array;
  name: string;
}

export interface PoolLike {
  listen(onEvent: (e: NostrEvent) => void, onStatus?: (open: number) => void): void;
  subscribe(filter: NostrFilter | null): void;
  publish(event: NostrEvent): number;
  close(): void;
}

export interface RendezvousOptions {
  myDid: string;
  mySecretKey: Uint8Array;
  pool: PoolLike;
  contacts: () => Promise<RvContact[]>;
  /** A contact is looking for us (not while we are calling them and win). */
  onOffer: (contact: RvContact, invitation: string) => void;
  onStatus?: (openRelays: number) => void;
  now?: () => number;
}

interface Payload {
  k: "offer" | "answer";
  inv: string;
  f: string;
}

interface Call {
  onAnswer: (invitation: string) => void;
  /** We lost the tie-break: their offer is handed here instead of to onOffer. */
  onTheirOffer: (invitation: string) => void;
  stop: () => void;
}

function validPayload(v: unknown): Payload | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if ((o.k !== "offer" && o.k !== "answer") || typeof o.inv !== "string" || typeof o.f !== "string") return null;
  if (!/^p2p1:[A-Za-z0-9_-]+$/.test(o.inv) || o.inv.length > MAX_INVITE_CHARS) return null;
  return { k: o.k, inv: o.inv, f: o.f };
}

export class Rendezvous {
  private readonly o: RendezvousOptions;
  private keys = new Map<string, { contact: RvContact; key: Uint8Array }>();
  private topicIndex = new Map<string, string>();
  private readonly calls = new Map<string, Call>();
  private readonly seen = new Set<string>();
  /** The last offer each contact sent us: a call we start later may have to answer it. */
  private readonly lastOffer = new Map<string, { inv: string; at: number }>();
  private epochTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: RendezvousOptions) {
    this.o = options;
    options.pool.listen((e) => this.handle(e), options.onStatus);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Reads the contact book and listens on everyone's topics. Call again when it changes. */
  async refresh(): Promise<void> {
    const list = await this.o.contacts();
    if (this.stopped) return;
    const keys = new Map<string, { contact: RvContact; key: Uint8Array }>();
    for (const c of list) {
      try {
        keys.set(c.did, { contact: c, key: this.keys.get(c.did)?.key ?? pairKey(this.o.mySecretKey, this.o.myDid, c.publicKey, c.did) });
      } catch {
        /* a malformed key: that contact cannot be found this way */
      }
    }
    for (const [did, v] of this.keys) if (!keys.has(did)) v.key.fill(0);
    this.keys = keys;
    this.resubscribe();
  }

  /** Subscribes to the current topics and re-runs just after the next epoch starts. */
  private resubscribe(): void {
    clearTimeout(this.epochTimer);
    if (this.stopped) return;
    const now = this.now();
    const index = new Map<string, string>();
    for (const [did, { key }] of this.keys) for (const t of listenTopics(key, now)) index.set(t, did);
    this.topicIndex = index;
    this.o.pool.subscribe(index.size ? { kinds: [RENDEZVOUS_KIND], "#t": [...index.keys()], since: Math.floor(now / 1000) - SINCE_S } : null);
    const next = (epochOf(now) + 1) * EPOCH_MS - now + 1000;
    this.epochTimer = setTimeout(() => this.resubscribe(), next);
  }

  private publish(did: string, k: Payload["k"], inv: string): number {
    const entry = this.keys.get(did);
    if (!entry) return 0;
    const now = this.now();
    const topic = topicFor(entry.key, epochOf(now));
    const content = sealFor(entry.key, topic, { k, inv, f: this.o.myDid } satisfies Payload);
    return this.o.pool.publish(signEvent(RENDEZVOUS_KIND, [["t", topic]], content, Math.floor(now / 1000)));
  }

  /** Looks for a contact: publishes our offer until an answer comes, CALL_MAX_MS passes or stop(). */
  call(contact: RvContact, offerInvitation: string, onAnswer: (inv: string) => void, onTheirOffer: (inv: string) => void): () => void {
    this.calls.get(contact.did)?.stop();
    if (!this.keys.has(contact.did)) {
      this.keys.set(contact.did, { contact, key: pairKey(this.o.mySecretKey, this.o.myDid, contact.publicKey, contact.did) });
      this.resubscribe();
    }
    const started = this.now();
    const send = () => {
      if (this.now() - started > CALL_MAX_MS) return stop();
      this.publish(contact.did, "offer", offerInvitation);
    };
    const timer = setInterval(send, OFFER_REPEAT_MS);
    const stop = () => {
      clearInterval(timer);
      if (this.calls.get(contact.did) === call) this.calls.delete(contact.did);
    };
    const call: Call = { onAnswer, onTheirOffer, stop };
    this.calls.set(contact.did, call);
    // They were already looking for us: if their offer wins the tie-break, answer it instead.
    const theirs = this.lastOffer.get(contact.did);
    if (theirs && this.now() - theirs.at < CALL_MAX_MS && this.o.myDid > contact.did) {
      clearInterval(timer);
      this.calls.delete(contact.did);
      queueMicrotask(() => onTheirOffer(theirs.inv));
      return () => undefined;
    }
    send();
    return stop;
  }

  /** Sends our answer to a contact's offer, a few times (their listener may be reconnecting). */
  answer(contact: RvContact, answerInvitation: string): () => void {
    const started = this.now();
    const send = () => {
      if (this.now() - started > ANSWER_MAX_MS) return clearInterval(timer);
      this.publish(contact.did, "answer", answerInvitation);
    };
    const timer = setInterval(send, ANSWER_REPEAT_MS);
    send();
    return () => clearInterval(timer);
  }

  private handle(e: NostrEvent): void {
    if (this.stopped || e.kind !== RENDEZVOUS_KIND) return;
    const topic = topicOf(e);
    const did = topic ? this.topicIndex.get(topic) : undefined;
    if (!topic || !did) return;
    const entry = this.keys.get(did);
    if (!entry) return;
    const p = validPayload(openFor(entry.key, topic, e.content));
    // Our own events come back on the same topic; anything else that opens is from the contact
    // (only the two of us hold the key), but its invitation is still checked like a QR's.
    if (!p || p.f === this.o.myDid || p.f !== did) return;
    // The same offer is republished every 30 s: hand it on once.
    const mark = `${p.k}:${p.inv}`;
    if (this.seen.has(mark)) return;
    this.seen.add(mark);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    const call = this.calls.get(did);
    if (p.k === "offer") this.lastOffer.set(did, { inv: p.inv, at: this.now() });
    if (p.k === "answer") {
      call?.onAnswer(p.inv);
      return;
    }
    if (call) {
      // Both are looking: the smaller did's offer stands; the other side answers it.
      if (this.o.myDid < did) return;
      call.stop();
      call.onTheirOffer(p.inv);
      return;
    }
    this.o.onOffer(entry.contact, p.inv);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.epochTimer);
    for (const c of this.calls.values()) c.stop();
    this.calls.clear();
    for (const v of this.keys.values()) v.key.fill(0);
    this.keys.clear();
    this.o.pool.close();
  }
}
