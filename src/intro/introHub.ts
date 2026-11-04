/**
 * Introduction through a mutual contact (M8). Design and threat model: docs/INTRODUCTIONS.md.
 *
 * A one-to-one chat holds one live link at a time, but an introducer C must hold live links
 * to A and to B at the same time, so a WebRTC offer and its answer can cross C within ICE's
 * timers. IntroHub is that small multi-link holder. It lives behind every screen (App), takes
 * pairwise links (PeerLink + SecureSession) made by the normal connect flow, and speaks only
 * the intro-* control messages inside those encrypted sessions.
 *
 * The A<->B link itself is made by GroupLinker (group/groupLinker.ts): signed invitations
 * relayed through C, then a direct link, the hello handshake and a fresh SecureSession.
 * The relay can refuse to forward, but cannot forge: GroupLinker refuses an invitation not
 * signed by exactly the did:key C named in the introduction.
 *
 * Roles, per introduction id:
 *  - introducer (C): `introductions`
 *  - introduced (A or B): `invites`
 *  - requester (A, flow b): `requestsOut`; the request owner (C): `requestsIn`
 *
 * Privacy: the hub never reads the contact book as a list. It gets `get`/`save`/`canAdd` only,
 * and sends a did and a name only for the two people being introduced.
 */
import { publicKeyToDidKey } from "../identity/didKey";
import type { DidKey, Ed25519KeyPair } from "../identity/types";
import {
  CONTACT_LIMIT_MESSAGE,
  ContactLimitError,
  type Contact,
  type IntroducedBy,
} from "../contacts/contacts";
import { CONTROL_MARK, decodeIntroControl, encodeControl } from "../p2p/control";
import { isEncryptedMessage, SessionError, type SecureSession } from "../p2p/secureSession";
import { GroupLinker, type AutoLink, type LinkFactory } from "../group/groupLinker";
import {
  cleanIntroName,
  INTRO_TTL_MS,
  MAX_INTRO_RELAYS,
  newIntroId,
  type IntroMessage,
} from "./introMessages";

/** A pairwise link the hub can use: an AutoLink with an optional close notification (PeerLink has it). */
export type HubLink = AutoLink & { onClose?: (handler: (reason: string) => void) => () => void };

/** What the hub needs from the contact book. Deliberately no "list". */
export interface IntroContacts {
  get(did: string): Promise<Contact | null>;
  save(contact: Contact): Promise<void>;
  canAdd(): Promise<boolean>;
}

export interface IntroHubOptions {
  identity: Ed25519KeyPair;
  factory: LinkFactory;
  contacts: IntroContacts;
  /** Clock, for tests. */
  now?: () => number;
  /** GroupLinker's connect timeout. */
  timeoutMs?: number;
  /** How often expired entries are swept (0 = never, tests call sweep()). */
  sweepMs?: number;
}

export interface Person {
  did: DidKey;
  name: string;
}

export type SideState = "waiting" | "accepted" | "declined";
export type IntroductionState = "sent" | "ready" | "done" | "declined" | "cancelled" | "expired";
export type InviteState =
  | "pending"
  | "accepted"
  | "linking"
  | "done"
  | "declined"
  | "cancelled"
  | "expired"
  | "failed";
export type RequestState = "sent" | "pending" | "answered" | "declined" | "expired";

export interface IntroductionView {
  id: string;
  a: Person;
  b: Person;
  aState: SideState;
  bState: SideState;
  state: IntroductionState;
  exp: number;
  /** Set when this introduction answers a request from `a`. */
  req?: string;
}

export interface InviteView {
  id: string;
  /** The introducer (C), named as this device knows it. */
  via: Person;
  /** The person C wants to introduce, with the name C gave. */
  peer: Person;
  exp: number;
  state: InviteState;
  /** True when this invitation answers our own request to C. */
  requested: boolean;
  /** Already in the contact book. */
  known: boolean;
  /** Bulgarian source text, for t(). */
  error?: string;
}

export interface RequestView {
  id: string;
  /** For an outgoing request: the contact asked (C). For an incoming one: the asker (A). */
  peer: Person;
  exp: number;
  state: RequestState;
}

export interface HubSnapshot {
  linked: Person[];
  introductions: IntroductionView[];
  invites: InviteView[];
  requestsOut: RequestView[];
  requestsIn: RequestView[];
  /** New contacts made by an introduction whose link is still open, ready for a chat. */
  fresh: Person[];
  /** Bulgarian source text of the last problem, for t(). */
  error: string | null;
}

interface LinkEntry {
  contact: Contact;
  link: HubLink;
  session: SecureSession;
  sendQueue: Promise<unknown>;
  recvQueue: Promise<unknown>;
  off: Array<() => void>;
  /** Resolves on the first message from the peer (the responder's sending chain starts then). */
  ready: Promise<void>;
  markReady: () => void;
}

interface Introduction extends IntroductionView {
  relays: number;
}

interface Invite extends InviteView {
  linker: GroupLinker | null;
}

export interface FreshLink {
  contact: Contact;
  link: AutoLink;
  session: SecureSession;
}

/**
 * A control message nobody understands: decodeControl returns null for it. The initiator of a
 * link sends it at once, so the responder's ratchet can start sending (Double Ratchet).
 */
const LINK_PING = `${CONTROL_MARK}{"t":"ping"}`;
/** How long the responder of a link waits for the initiator's first message before a send fails. */
const FIRST_MESSAGE_WAIT_MS = 30_000;

/** At most this many incoming invitations or requests are kept; older ones are dropped. */
const MAX_INCOMING = 20;
/** Clock skew allowed on an introduction's expiry. */
const EXP_SKEW_MS = 60_000;

export class IntroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntroError";
  }
}

export class IntroHub {
  private readonly opts: IntroHubOptions;
  readonly myDid: DidKey;
  private readonly links = new Map<DidKey, LinkEntry>();
  private readonly introductions = new Map<string, Introduction>();
  private readonly invites = new Map<string, Invite>();
  private readonly requestsOut = new Map<string, RequestView>();
  private readonly requestsIn = new Map<string, RequestView>();
  private readonly fresh = new Map<DidKey, FreshLink>();
  private readonly listeners = new Set<() => void>();
  private error: string | null = null;
  private view: HubSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: IntroHubOptions) {
    this.opts = opts;
    this.myDid = publicKeyToDidKey(opts.identity.publicKey);
    this.view = this.build();
    const every = opts.sweepMs ?? 15_000;
    if (every > 0) this.timer = setInterval(() => this.sweep(), every);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /* ---------- view ---------- */

  get snapshot(): HubSnapshot {
    return this.view;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.view = this.build();
    for (const fn of [...this.listeners]) fn();
  }

  private build(): HubSnapshot {
    const strip = (i: Invite): InviteView => {
      const { linker: _linker, ...v } = i;
      return { ...v };
    };
    return {
      linked: [...this.links.values()].map((e) => ({ did: e.contact.did, name: e.contact.name })),
      introductions: [...this.introductions.values()].map((i) => {
        const { relays: _relays, ...v } = i;
        return { ...v };
      }),
      invites: [...this.invites.values()].map(strip),
      requestsOut: [...this.requestsOut.values()].map((r) => ({ ...r })),
      requestsIn: [...this.requestsIn.values()].map((r) => ({ ...r })),
      fresh: [...this.fresh.values()].map((f) => ({ did: f.contact.did, name: f.contact.name })),
      error: this.error,
    };
  }

  private fail(message: string): void {
    this.error = message;
    this.changed();
  }

  clearError(): void {
    this.error = null;
    this.changed();
  }

  isLinked(did: DidKey): boolean {
    return this.links.has(did);
  }

  /* ---------- links ---------- */

  /**
   * Hands the hub a pairwise link to a saved contact (from the connect flow). The hub owns it
   * from now on and closes it on detach or close. A second link to the same contact replaces the first.
   */
  attach(contact: Contact, link: HubLink, session: SecureSession): void {
    if (this.closed) {
      link.close();
      return;
    }
    if (contact.did === this.myDid) throw new IntroError("Това е твоята собствена самоличност.");
    if (publicKeyToDidKey(contact.publicKey) !== contact.did) throw new IntroError("Контактът е повреден.");
    this.detach(contact.did);
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const entry: LinkEntry = {
      contact,
      link,
      session,
      sendQueue: Promise.resolve(),
      recvQueue: Promise.resolve(),
      off: [],
      ready,
      markReady,
    };
    entry.off.push(
      link.onMessage((text) => {
        if (!isEncryptedMessage(text)) return;
        const opened = entry.recvQueue.then(() => session.open(text));
        entry.recvQueue = opened.catch(() => undefined);
        // Dispatch outside the queue: a handler may send, and sending must not wait for this queue.
        opened.then(
          (plaintext) => {
            entry.markReady();
            if (this.links.get(contact.did) !== entry) return;
            const control = decodeIntroControl(plaintext);
            if (!control) return;
            void this.dispatch(contact.did, control).catch((err: unknown) =>
              this.fail(err instanceof Error ? err.message : "Съобщението за запознанство не беше прието."),
            );
          },
          () => undefined,
        );
      }),
    );
    if (link.onClose) {
      entry.off.push(
        link.onClose(() => {
          if (this.links.get(contact.did) === entry) this.lost(contact.did);
        }),
      );
    }
    this.links.set(contact.did, entry);
    // The initiator starts the ratchet; for the responder this throws and its sends wait instead.
    const ping = entry.sendQueue.then(async () => {
      link.send(await session.seal(LINK_PING));
    });
    entry.sendQueue = ping.catch(() => undefined);
    this.changed();
  }

  /** Closes the link to `did` and ends everything that needed it. */
  detach(did: DidKey): void {
    const entry = this.links.get(did);
    if (!entry) return;
    this.links.delete(did);
    for (const off of entry.off) off();
    entry.link.close();
    this.lost(did);
  }

  /** A link went away: introductions that needed it cannot finish. */
  private lost(did: DidKey): void {
    if (this.links.get(did)) {
      const entry = this.links.get(did)!;
      this.links.delete(did);
      for (const off of entry.off) off();
    }
    for (const intro of this.introductions.values()) {
      if ((intro.a.did === did || intro.b.did === did) && intro.state === "sent") {
        intro.state = "cancelled";
        const other = intro.a.did === did ? intro.b.did : intro.a.did;
        void this.send(other, { t: "intro-cancel", id: intro.id }).catch(() => undefined);
      }
    }
    for (const inv of this.invites.values()) {
      // Once linking, the relay is no longer needed only after the link is made; a lost C ends it.
      if (inv.via.did === did && (inv.state === "pending" || inv.state === "accepted" || inv.state === "linking")) {
        this.endInvite(inv, "cancelled");
      }
    }
    for (const r of this.requestsIn.values()) if (r.peer.did === did && r.state === "pending") r.state = "expired";
    this.changed();
  }

  private async send(did: DidKey, message: IntroMessage): Promise<void> {
    const entry = this.links.get(did);
    if (!entry) throw new IntroError("Няма връзка с този контакт.");
    const plaintext = encodeControl(message);
    const task = entry.sendQueue.then(async () => {
      let wire: string;
      try {
        wire = await entry.session.seal(plaintext);
      } catch (err) {
        if (!(err instanceof SessionError)) throw err;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(err), FIRST_MESSAGE_WAIT_MS);
        });
        await Promise.race([entry.ready, timeout]).finally(() => clearTimeout(timer));
        wire = await entry.session.seal(plaintext);
      }
      entry.link.send(wire);
    });
    entry.sendQueue = task.catch(() => undefined);
    await task;
  }

  /* ---------- introducer (C) ---------- */

  /**
   * Flow (a), or the answer to a request (flow b, `req`): C introduces `a` and `b`. Both must be
   * linked to this hub now. Each gets the other's did and the name C knows them by, nothing else.
   */
  async introduce(a: Contact, b: Contact, req?: string): Promise<string> {
    if (this.closed) throw new IntroError("Запознанствата са затворени.");
    if (a.did === b.did) throw new IntroError("Избери двама различни души.");
    if (a.did === this.myDid || b.did === this.myDid) throw new IntroError("Не можеш да запознаеш себе си.");
    if (!this.links.has(a.did) || !this.links.has(b.did)) throw new IntroError("Първо се свържи и с двамата.");
    if (req !== undefined) {
      const r = this.requestsIn.get(req);
      if (!r || r.state !== "pending" || r.peer.did !== a.did) throw new IntroError("Молбата вече не е активна.");
    }
    const id = newIntroId();
    const exp = this.now() + INTRO_TTL_MS;
    const nameA = cleanIntroName(a.name, "Контакт");
    const nameB = cleanIntroName(b.name, "Контакт");
    const intro: Introduction = {
      id,
      a: { did: a.did, name: nameA },
      b: { did: b.did, name: nameB },
      aState: "waiting",
      bState: "waiting",
      state: "sent",
      exp,
      relays: 0,
    };
    if (req !== undefined) intro.req = req;
    this.introductions.set(id, intro);
    try {
      await this.send(a.did, { t: "intro-offer", id, did: b.did, name: nameB, exp, ...(req ? { req } : {}) });
      await this.send(b.did, { t: "intro-offer", id, did: a.did, name: nameA, exp });
    } catch (err) {
      intro.state = "cancelled";
      await this.send(a.did, { t: "intro-cancel", id }).catch(() => undefined);
      this.changed();
      throw err;
    }
    if (req !== undefined) {
      const r = this.requestsIn.get(req);
      if (r) r.state = "answered";
    }
    this.changed();
    return id;
  }

  /** C ends an introduction it started. */
  async cancelIntroduction(id: string): Promise<void> {
    const intro = this.introductions.get(id);
    if (!intro || (intro.state !== "sent" && intro.state !== "ready")) return;
    intro.state = "cancelled";
    this.changed();
    await this.send(intro.a.did, { t: "intro-cancel", id }).catch(() => undefined);
    await this.send(intro.b.did, { t: "intro-cancel", id }).catch(() => undefined);
  }

  /** C declines a request (flow b). */
  async declineRequest(id: string): Promise<void> {
    const r = this.requestsIn.get(id);
    if (!r || r.state !== "pending") return;
    r.state = "declined";
    this.changed();
    await this.send(r.peer.did, { t: "intro-decline", id }).catch(() => undefined);
  }

  /* ---------- requester (A, flow b) ---------- */

  /** A asks C (linked) to introduce A to someone from C's own book. The request carries no names. */
  async requestIntroduction(c: DidKey): Promise<string> {
    if (this.closed) throw new IntroError("Запознанствата са затворени.");
    const entry = this.links.get(c);
    if (!entry) throw new IntroError("Първо се свържи с този контакт.");
    const id = newIntroId();
    this.requestsOut.set(id, {
      id,
      peer: { did: c, name: entry.contact.name },
      exp: this.now() + INTRO_TTL_MS,
      state: "sent",
    });
    this.changed();
    await this.send(c, { t: "intro-request", id });
    return id;
  }

  /* ---------- introduced (A or B) ---------- */

  /** Accept an invitation. Refused when the contact book is full. */
  async accept(id: string): Promise<void> {
    const inv = this.invites.get(id);
    if (!inv || inv.state !== "pending") return;
    if (inv.exp <= this.now()) {
      this.endInvite(inv, "expired");
      return;
    }
    if (!inv.known && !(await this.opts.contacts.canAdd())) {
      inv.error = CONTACT_LIMIT_MESSAGE;
      this.changed();
      throw new IntroError(CONTACT_LIMIT_MESSAGE);
    }
    inv.state = "accepted";
    delete inv.error;
    this.changed();
    await this.send(inv.via.did, { t: "intro-accept", id });
  }

  /** Decline an invitation (or step back from an accepted one before the link is made). */
  async decline(id: string): Promise<void> {
    const inv = this.invites.get(id);
    if (!inv || (inv.state !== "pending" && inv.state !== "accepted" && inv.state !== "linking")) return;
    this.endInvite(inv, "declined");
    await this.send(inv.via.did, { t: "intro-decline", id }).catch(() => undefined);
  }

  /** The open link to a newly introduced contact, for the chat screen. The hub forgets it. */
  takeFresh(did: DidKey): FreshLink | null {
    const f = this.fresh.get(did) ?? null;
    if (f) {
      this.fresh.delete(did);
      this.changed();
    }
    return f;
  }

  private endInvite(inv: Invite, state: InviteState, error?: string): void {
    inv.state = state;
    if (error) inv.error = error;
    inv.linker?.close();
    inv.linker = null;
    this.changed();
  }

  /* ---------- incoming ---------- */

  private async dispatch(from: DidKey, m: IntroMessage): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    switch (m.t) {
      case "intro-request": {
        if (this.requestsIn.has(m.id)) return;
        const asker = this.links.get(from);
        if (!asker) return;
        this.keepBounded(this.requestsIn);
        this.requestsIn.set(m.id, {
          id: m.id,
          peer: { did: from, name: asker.contact.name },
          exp: now + INTRO_TTL_MS,
          state: "pending",
        });
        this.changed();
        return;
      }
      case "intro-offer": {
        if (this.invites.has(m.id)) return;
        if (m.did === this.myDid || m.did === from) return;
        if (m.exp <= now || m.exp > now + INTRO_TTL_MS + EXP_SKEW_MS) return;
        const via = this.links.get(from);
        if (!via) return;
        let requested = false;
        if (m.req !== undefined) {
          const r = this.requestsOut.get(m.req);
          // Only C, the contact we asked, can answer our request.
          if (!r || r.peer.did !== from || r.state !== "sent") return;
          r.state = "answered";
          requested = true;
        }
        const known = (await this.opts.contacts.get(m.did)) !== null;
        this.keepBounded(this.invites);
        this.invites.set(m.id, {
          id: m.id,
          via: { did: from, name: via.contact.name },
          peer: { did: m.did, name: m.name },
          exp: Math.min(m.exp, now + INTRO_TTL_MS),
          state: "pending",
          requested,
          known,
          linker: null,
        });
        this.changed();
        return;
      }
      case "intro-accept":
      case "intro-decline": {
        // C declined our request?
        const out = this.requestsOut.get(m.id);
        if (m.t === "intro-decline" && out && out.peer.did === from && out.state === "sent") {
          out.state = "declined";
          this.changed();
          return;
        }
        const intro = this.introductions.get(m.id);
        if (!intro || intro.state !== "sent") return;
        const side = intro.a.did === from ? "a" : intro.b.did === from ? "b" : null;
        if (!side) return;
        if (intro.exp <= now) {
          intro.state = "expired";
          this.changed();
          return;
        }
        if (m.t === "intro-decline") {
          if (side === "a") intro.aState = "declined";
          else intro.bState = "declined";
          intro.state = "declined";
          this.changed();
          const other = side === "a" ? intro.b.did : intro.a.did;
          await this.send(other, { t: "intro-cancel", id: m.id }).catch(() => undefined);
          return;
        }
        if (side === "a") intro.aState = "accepted";
        else intro.bState = "accepted";
        if (intro.aState === "accepted" && intro.bState === "accepted") {
          intro.state = "ready";
          this.changed();
          // The side with the smaller DID makes the WebRTC offer. The answering side is told
          // first, so it is ready before the relayed offer can reach it.
          const aOffers = intro.a.did < intro.b.did;
          const [offerer, answerer] = aOffers ? [intro.a.did, intro.b.did] : [intro.b.did, intro.a.did];
          await this.send(answerer, { t: "intro-ready", id: m.id, offer: false });
          await this.send(offerer, { t: "intro-ready", id: m.id, offer: true });
          return;
        }
        this.changed();
        return;
      }
      case "intro-ready": {
        const inv = this.invites.get(m.id);
        if (!inv || inv.via.did !== from || inv.state !== "accepted") return;
        if (inv.exp <= now) {
          this.endInvite(inv, "expired");
          return;
        }
        inv.state = "linking";
        inv.linker = this.makeLinker(inv);
        this.changed();
        if (m.offer) {
          await inv.linker.offerTo(inv.peer.did).catch((err: unknown) => {
            this.endInvite(inv, "failed", err instanceof Error ? err.message : "Връзката не можа да се направи.");
          });
        }
        return;
      }
      case "intro-relay": {
        // C: forward between the two sides of a ready introduction, nothing else.
        const intro = this.introductions.get(m.id);
        if (intro) {
          if (intro.state !== "ready" && intro.state !== "done") return;
          if (intro.exp <= now || intro.relays >= MAX_INTRO_RELAYS) return;
          const to = intro.a.did === from ? intro.b.did : intro.b.did === from ? intro.a.did : null;
          if (!to) return;
          intro.relays++;
          if (intro.relays >= 2) intro.state = "done";
          this.changed();
          await this.send(to, { t: "intro-relay", id: m.id, inv: m.inv });
          return;
        }
        // A or B: an invitation from the introduced peer, through C.
        const inv = this.invites.get(m.id);
        if (!inv || inv.via.did !== from || inv.state !== "linking" || !inv.linker) return;
        const linker = inv.linker;
        // The signer must be exactly the did C named (GroupLinker checks the key against `from`).
        void linker.receive(inv.peer.did, m.inv).catch((err: unknown) => {
          if (inv.linker !== linker) return;
          this.endInvite(inv, "failed", err instanceof Error ? err.message : "Поканата не беше приета.");
          void this.send(inv.via.did, { t: "intro-decline", id: inv.id }).catch(() => undefined);
        });
        return;
      }
      case "intro-cancel": {
        const inv = this.invites.get(m.id);
        if (!inv || inv.via.did !== from) return;
        if (inv.state === "pending" || inv.state === "accepted" || inv.state === "linking") this.endInvite(inv, "cancelled");
        return;
      }
      default:
        return;
    }
  }

  private makeLinker(inv: Invite): GroupLinker {
    const linker: GroupLinker = new GroupLinker({
      identity: this.opts.identity,
      factory: this.opts.factory,
      timeoutMs: this.opts.timeoutMs,
      relay: async (_to, invitation) => {
        await this.send(inv.via.did, { t: "intro-relay", id: inv.id, inv: invitation });
      },
      linked: (peer, peerPublicKey, link, session) => {
        void this.linked(inv, linker, peer, peerPublicKey, link, session);
      },
    });
    return linker;
  }

  /** The direct link to the introduced peer is up: save the contact (unverified) and keep the link. */
  private async linked(
    inv: Invite,
    linker: GroupLinker,
    peer: DidKey,
    peerPublicKey: Uint8Array,
    link: AutoLink,
    session: SecureSession,
  ): Promise<void> {
    if (inv.linker !== linker || inv.state !== "linking" || this.closed) {
      link.close();
      return;
    }
    // GroupLinker already refused any other signer; checked again here, on the saved key.
    if (peer !== inv.peer.did || publicKeyToDidKey(peerPublicKey) !== inv.peer.did) {
      link.close();
      this.endInvite(inv, "failed", "Поканата не е подписана от човека, когото представиха.");
      return;
    }
    const introducedBy: IntroducedBy = { did: inv.via.did, name: inv.via.name };
    let contact: Contact;
    try {
      const existing = await this.opts.contacts.get(peer);
      // A contact already in the book keeps its name and its verified flag.
      contact = existing ?? {
        did: peer,
        publicKey: peerPublicKey,
        name: inv.peer.name,
        verified: false,
        addedAt: this.now(),
        introducedBy,
      };
      if (!existing) await this.opts.contacts.save(contact);
    } catch (err) {
      link.close();
      this.endInvite(
        inv,
        "failed",
        err instanceof ContactLimitError ? CONTACT_LIMIT_MESSAGE : "Контактът не можа да се запише.",
      );
      return;
    }
    if (this.closed) {
      link.close();
      return;
    }
    const old = this.fresh.get(peer);
    old?.link.close();
    this.fresh.set(peer, { contact, link, session });
    // Start the ratchet now: the side that made the WebRTC offer can send at once, and the other
    // side cannot send before this first message arrives. PeerLink keeps it until the chat
    // subscribes, and the chat ignores the ping. On the answering side seal() throws: ignore it.
    void session
      .seal(LINK_PING)
      .then((wire) => link.send(wire))
      .catch(() => undefined);
    inv.state = "done";
    inv.linker = null;
    linker.close();
    this.changed();
  }

  private keepBounded<T extends { exp: number }>(map: Map<string, T>): void {
    while (map.size >= MAX_INCOMING) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      const v = map.get(oldest) as unknown as Invite;
      v.linker?.close?.();
      map.delete(oldest);
    }
  }

  /** Marks expired entries and closes their link attempts. Runs on a timer; tests call it. */
  sweep(): void {
    const now = this.now();
    let dirty = false;
    for (const intro of this.introductions.values()) {
      if ((intro.state === "sent" || intro.state === "ready") && intro.exp <= now) {
        intro.state = intro.state === "ready" ? "done" : "expired";
        dirty = true;
      }
    }
    for (const inv of this.invites.values()) {
      if ((inv.state === "pending" || inv.state === "accepted" || inv.state === "linking") && inv.exp <= now) {
        inv.state = "expired";
        inv.linker?.close();
        inv.linker = null;
        dirty = true;
      }
    }
    for (const map of [this.requestsIn, this.requestsOut]) {
      for (const r of map.values()) {
        if ((r.state === "sent" || r.state === "pending") && r.exp <= now) {
          r.state = "expired";
          dirty = true;
        }
      }
    }
    if (dirty) this.changed();
  }

  /** Closes every link and attempt and forgets everything (lock, or "Край" on the screen). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const inv of this.invites.values()) {
      inv.linker?.close();
      inv.linker = null;
    }
    for (const [did, entry] of [...this.links]) {
      this.links.delete(did);
      for (const off of entry.off) off();
      entry.link.close();
    }
    for (const f of this.fresh.values()) f.link.close();
    this.fresh.clear();
    this.introductions.clear();
    this.invites.clear();
    this.requestsIn.clear();
    this.requestsOut.clear();
    this.changed();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
