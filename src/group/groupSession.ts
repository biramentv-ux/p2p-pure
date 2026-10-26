/**
 * Live state of one group on this device: the mesh router, one pairwise link per member,
 * the messages and notices shown to the user, and the subscribers that re-render the UI.
 *
 * Each pairwise link here is a link of its own, made with the normal connect flow or by
 * auto-linking through the admin (groupLinker.ts). It is not shared with the one-to-one
 * chats, so opening a chat never changes group traffic.
 *
 * Storage: with a history key, the group (signed snapshot, epoch keys, role, counter, photo)
 * and its messages are saved encrypted (groupStore.ts) after every change, so the group
 * survives a reload or the idle lock. `GroupSession.restore` brings it back after unlock.
 *
 * Group photo: only its hash is in the signed snapshot. A member that does not have the
 * matching photo asks the admin for it (gphoto); the bytes come as the usual photo frames
 * (p2p/photo.ts) inside the encrypted pairwise link, and are shown only if their SHA-256
 * equals the signed hash.
 *
 * Ratchet ordering: every link has its own send queue and its own receive queue. A receive
 * can trigger a send (the mesh answers a join or a vote), and a single queue would wait for
 * itself. The responder of a link cannot send before the initiator's first message, so the
 * initiator sends a ping as soon as the link is attached, and the responder's sends wait for it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Contact } from "../contacts/contacts";
import type { Ed25519KeyPair } from "../identity/types";
import type { Vars } from "../i18n/core";
import type { PeerLink } from "../p2p/peer";
import { isEncryptedMessage, SessionError, type SecureSession } from "../p2p/secureSession";
import type { CipherSuite } from "../p2p/cipherSuite";
import { bytesEqual } from "../p2p/invitation";
import { buildPhotoFrames, chunkCount, FRAME_MARK, PhotoReceiver, sniffMime, toDataUrl } from "../p2p/photo";
import { GROUP_MARK, isGroupWire, type GroupWire } from "./groupChat";
import { GroupChat } from "./groupChat";
import { GroupLinker, type AutoLink, type LinkFactory } from "./groupLinker";
import { GroupMesh, type MeshEvents } from "./groupMesh";
import type { GroupState } from "./groupModel";
import {
  appendGroupMessage,
  deleteGroup,
  loadGroupHistory,
  loadGroups,
  photoUrlHash,
  saveGroup,
  type GroupHistoryEntry,
} from "./groupStore";

/** The group photo is small: it is sent to every member, one link at a time. */
export const MAX_GROUP_PHOTO_BYTES = 256_000;
/** How many times one member may ask for the same photo. */
const MAX_PHOTO_SENDS = 3;
/** How long the responder of a link waits for the initiator's first message before a send fails. */
const FIRST_MESSAGE_WAIT_MS = 30_000;
/** A group wire the mesh does not know: it only starts the ratchet on the other side. */
const LINK_PING = `${GROUP_MARK}{"t":"ping"}`;
const PHOTO_HEADER = `${FRAME_MARK}P|`;
const PHOTO_CHUNK = `${FRAME_MARK}D|`;

export interface GroupMessageView {
  id: number;
  from: string;
  text: string;
  mine: boolean;
  at: number;
}

/** A notice in Bulgarian source text with its placeholders, translated by the screen. */
export interface GroupNotice {
  text: string;
  vars?: Vars;
}

export interface GroupView {
  state: GroupState | null;
  isAdmin: boolean;
  linked: string[];
  /** Linked peers whose safety code nobody has compared yet (linked through the admin). */
  unverified: string[];
  /** Peers a link is being made to automatically. */
  linking: string[];
  messages: GroupMessageView[];
  notices: GroupNotice[];
  /** A suite change this member is asked to approve. */
  suiteRequest: CipherSuite | null;
  joined: boolean;
  removed: boolean;
  pending: boolean;
  /** The group photo (data URL), only when its bytes match the signed hash. */
  photo: string | null;
  /** The group photo is on its way: frames received of total. */
  photoProgress: { done: number; total: number } | null;
}

/** What the group needs from a link. PeerLink has all of it. */
export type GroupLink = Pick<PeerLink, "send" | "onMessage" | "close"> & Partial<Pick<PeerLink, "waitForDrain" | "isOpen">>;

export interface GroupSessionOptions {
  chat?: GroupChat | null;
  /** Key for encryption at rest (the history key). Without it the group lives only in memory. */
  historyKey?: Uint8Array | null;
  /** Makes WebRTC links for auto-linking. Without it members link only by QR. */
  linkFactory?: LinkFactory | null;
  /** Looks up a contact, so a peer that is already a verified contact shows as verified. */
  findContact?: (did: string) => Promise<Contact | null>;
  /** Restored photo (already checked against the signed hash by the store). */
  photo?: string | null;
  /** Restored history. */
  history?: GroupHistoryEntry[];
}

interface LinkEntry {
  contact: Contact;
  link: GroupLink;
  session: SecureSession;
  unsubscribe: () => void;
  receiver: PhotoReceiver;
  sendQueue: Promise<unknown>;
  recvQueue: Promise<unknown>;
  /** Resolves once a message from the peer was opened: from then on this side can always send. */
  ready: Promise<void>;
}

function hashHex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class GroupSession {
  private readonly mesh: GroupMesh;
  private readonly links = new Map<string, LinkEntry>();
  private readonly subscribers = new Set<() => void>();
  private saveQueue: Promise<unknown> = Promise.resolve();
  private view: GroupView;
  private nextId = 1;
  private readonly myDid: string;
  private readonly keys: Ed25519KeyPair;
  private readonly historyKey: Uint8Array | null;
  private readonly findContact: ((did: string) => Promise<Contact | null>) | null;
  private readonly linker: GroupLinker | null;
  private groupId: string | null = null;
  private savedFingerprint = "";
  private closed = false;
  private photo: string | null = null;
  private photoHash: string | null = null;
  /** The link the photo was asked from, and the hash asked for. */
  private photoFrom: string | null = null;
  private photoAsked: string | null = null;
  private readonly photoSends = new Map<string, number>();

  constructor(keys: Ed25519KeyPair, chatOrOptions: GroupChat | null | GroupSessionOptions = null) {
    const options: GroupSessionOptions =
      chatOrOptions === null || chatOrOptions instanceof GroupChat ? { chat: chatOrOptions } : chatOrOptions;
    const chat = options.chat ?? null;
    this.keys = keys;
    this.historyKey = options.historyKey ?? null;
    this.findContact = options.findContact ?? null;
    const events: MeshEvents = {
      message: (from, text) => this.addMessage(from, text, from === this.myDid),
      membership: () => {
        this.refresh();
        this.maybeRequestPhoto();
      },
      suite: () => this.refresh(),
      suiteRequested: (suite) => {
        this.view = { ...this.view, suiteRequest: suite };
        this.refresh();
      },
      pending: () => {
        this.view = { ...this.view, pending: true };
        this.refresh();
      },
      joined: () => {
        this.view = { ...this.view, joined: true, pending: false };
        this.refresh();
        this.persist();
        this.maybeRequestPhoto();
      },
      removed: () => this.onRemoved(),
      error: (message) => this.notice(message),
      introduced: (peer) => this.onIntroduced(peer),
      relayed: (from, invitation) => this.onRelayed(from, invitation),
      photoRequested: (from, hash) => this.sendPhotoTo(from, hash),
    };
    this.mesh = new GroupMesh(keys, events, chat);
    this.myDid = this.mesh.myDid;
    this.linker = options.linkFactory
      ? new GroupLinker({
          identity: keys,
          factory: options.linkFactory,
          relay: (to, invitation) => this.mesh.relay(to, invitation),
          linked: (peer, publicKey, link, session) => void this.onAutoLinked(peer, publicKey, link, session),
        })
      : null;
    if (options.photo && photoUrlHash(options.photo) === chat?.snapshot.photoHash) {
      this.photo = options.photo;
      this.photoHash = chat.snapshot.photoHash;
    }
    const messages = (options.history ?? []).map((h) => ({
      id: this.nextId++,
      from: h.from,
      text: h.text,
      mine: h.from === this.myDid,
      at: h.at,
    }));
    this.view = {
      state: null,
      isAdmin: false,
      linked: [],
      unverified: [],
      linking: [],
      messages,
      notices: [],
      suiteRequest: null,
      joined: chat !== null,
      removed: false,
      pending: false,
      photo: null,
      photoProgress: null,
    };
    this.refresh();
  }

  get me(): string {
    return this.myDid;
  }

  get myPublicKey(): Uint8Array {
    return this.keys.publicKey;
  }

  /** Snapshot for rendering. A new object each time something changed. */
  get snapshot(): GroupView {
    return this.view;
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** The contact behind a linked member, if this device has a link to it. */
  contactOf(did: string): Contact | undefined {
    return this.links.get(did)?.contact;
  }

  isLinked(did: string): boolean {
    return this.links.has(did);
  }

  /** Waits until pending saves are written. */
  async flush(): Promise<void> {
    await this.saveQueue;
  }

  /** Attaches a freshly connected pairwise link to the mesh. Replaces an older link to the same person. */
  attach(contact: Contact, link: GroupLink, session: SecureSession): void {
    const old = this.links.get(contact.did);
    if (old) {
      old.unsubscribe();
      old.link.close();
      this.mesh.detach(contact.did);
    }
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const entry: LinkEntry = {
      contact,
      link,
      session,
      unsubscribe: () => undefined,
      receiver: new PhotoReceiver(),
      sendQueue: Promise.resolve(),
      recvQueue: Promise.resolve(),
      ready,
    };
    entry.unsubscribe = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void this.enqueueReceive(entry, async () => {
        const plaintext = await session.open(text);
        // The first message from the peer also starts this side's sending chain.
        markReady();
        if (isGroupWire(plaintext)) {
          await this.mesh.handle(contact.did, plaintext);
          this.persist();
        } else if (plaintext.startsWith(PHOTO_HEADER) || plaintext.startsWith(PHOTO_CHUNK)) {
          this.onPhotoFrame(contact.did, entry, plaintext);
        }
      }).catch(() => this.notice("Съобщение от участник не можа да се прочете."));
    });
    this.links.set(contact.did, entry);
    this.mesh.attach(contact.did, (plaintext) => this.sendOn(entry, plaintext));
    // The side that can send first (the initiator of the link) says hello at once, so the
    // other side's ratchet can send too. The responder's attempt fails quietly.
    void this.enqueueSend(entry, async () => {
      link.send(await session.seal(LINK_PING));
    }).catch(() => undefined);
    this.refresh();
    if (contact.did === this.view.state?.creatorDid) {
      // A new link to the admin: ask again for a photo that did not arrive on the old one.
      if (this.photoHash !== this.view.state.photoHash) this.photoAsked = null;
      this.maybeRequestPhoto();
    }
  }

  /** Closes the link to one person. */
  drop(did: string): void {
    const entry = this.links.get(did);
    if (!entry) return;
    entry.unsubscribe();
    entry.link.close();
    this.links.delete(did);
    this.mesh.detach(did);
    if (this.photoFrom === did) this.photoFrom = null;
    this.refresh();
  }

  /** Closes every link and stops auto-linking. Saves already queued still finish. */
  closeAll(): void {
    this.closed = true;
    this.linker?.close();
    for (const did of [...this.links.keys()]) this.drop(did);
  }

  /** Creator only: starts a group with this device as the admin. */
  static create(
    keys: Ed25519KeyPair,
    groupId: string,
    name: string,
    creatorName: string,
    options: Omit<GroupSessionOptions, "chat" | "photo" | "history"> = {},
  ): GroupSession {
    const session = new GroupSession(keys, { ...options, chat: GroupChat.create(keys, groupId, name, creatorName) });
    session.persist();
    return session;
  }

  /**
   * Brings back the newest saved group this identity can open, with its history.
   * A record that fails any check (decryption, signature, membership) is skipped.
   */
  static async restore(
    keys: Ed25519KeyPair,
    historyKey: Uint8Array,
    options: Omit<GroupSessionOptions, "chat" | "historyKey" | "photo" | "history"> = {},
  ): Promise<GroupSession | null> {
    for (const saved of await loadGroups(historyKey)) {
      let chat: GroupChat;
      try {
        chat = GroupChat.restore(keys, saved.secrets);
      } catch {
        continue;
      }
      const history = await loadGroupHistory(historyKey, chat.snapshot.groupId);
      const session = new GroupSession(keys, { ...options, chat, historyKey, photo: saved.photo, history });
      // The counter moved ahead on restore: save that before anything is sent.
      session.persist();
      return session;
    }
    return null;
  }

  async invite(did: string, name: string): Promise<void> {
    await this.mesh.invite(did, name);
    this.notice("Поканен е {name}.", { name });
  }

  async remove(did: string): Promise<void> {
    await this.mesh.drop(did);
    this.drop(did);
    this.persist();
    this.notice("Участникът е махнат. Новият ключ е раздаден на останалите.");
  }

  async sendText(text: string): Promise<void> {
    await this.mesh.sendMessage(text);
    this.persist(); // the send counter moved
    this.addMessage(this.myDid, text, true);
  }

  async openSuite(suite: CipherSuite): Promise<void> {
    await this.mesh.openSuite(suite);
    this.notice("Предложението за смяна е изпратено на всички.");
  }

  async answerSuite(accept: boolean): Promise<void> {
    await this.mesh.answerSuite(accept);
    this.view = { ...this.view, suiteRequest: null };
    this.refresh();
  }

  /** Admin: sets the group photo. The bytes must already be a small JPEG, PNG or WebP. */
  async setPhoto(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0 || bytes.length > MAX_GROUP_PHOTO_BYTES) throw new Error("Снимката на групата е твърде голяма.");
    const mime = sniffMime(bytes);
    if (!mime) throw new Error("Файлът не е валидна снимка.");
    const hash = hashHex(bytes);
    const before = { photo: this.photo, hash: this.photoHash };
    // Set before the snapshot goes out: members ask for the bytes as soon as they see the hash.
    this.photo = toDataUrl(bytes, mime);
    this.photoHash = hash;
    this.photoSends.clear();
    try {
      await this.mesh.setPhoto(hash);
    } catch (err) {
      this.photo = before.photo;
      this.photoHash = before.hash;
      throw err;
    }
    this.persist();
    this.refresh();
    this.notice("Снимката на групата е сменена.");
  }

  /** Admin: removes the group photo. */
  async clearPhoto(): Promise<void> {
    await this.mesh.setPhoto(null);
    this.photo = null;
    this.photoHash = null;
    this.persist();
    this.refresh();
  }

  /** The user compared the safety code with this peer and it matched. */
  markVerified(did: string): void {
    const entry = this.links.get(did);
    if (!entry) return;
    entry.contact = { ...entry.contact, verified: true, verifiedAt: Date.now() };
    this.refresh();
  }

  /* ---------- auto-linking ---------- */

  private onIntroduced(peer: string): void {
    if (!this.linker || this.closed) return;
    const existing = this.links.get(peer);
    if (existing && existing.link.isOpen?.() !== false) return;
    void this.linker
      .offerTo(peer)
      .catch((err) => this.notice(err instanceof Error ? err.message : "Автоматичното свързване не успя."))
      .finally(() => this.refresh());
    this.refresh();
  }

  private onRelayed(from: string, invitation: string): void {
    if (!this.linker || this.closed) return;
    // The peer offers only when it has no link to this device, so a new offer replaces an old link.
    void this.linker
      .receive(from, invitation)
      .catch((err) => this.notice(err instanceof Error ? err.message : "Автоматичното свързване не успя."))
      .finally(() => this.refresh());
    this.refresh();
  }

  private async onAutoLinked(peer: string, publicKey: Uint8Array, link: AutoLink, session: SecureSession): Promise<void> {
    let contact: Contact | null = null;
    try {
      const known = await this.findContact?.(peer);
      if (known && known.verified && bytesEqual(known.publicKey, publicKey)) contact = known;
    } catch {
      contact = null;
    }
    if (this.closed) {
      link.close();
      return;
    }
    const name = this.mesh.peerName(peer) ?? contact?.name ?? "Участник";
    // Not compared by safety code: the link is bound to the key, the person is not verified.
    contact ??= { did: peer, publicKey, name, verified: false, addedAt: Date.now() };
    this.attach(contact, link, session);
    this.notice("Свързан автоматично с {name}.", { name });
  }

  /* ---------- group photo ---------- */

  private currentPhoto(): string | null {
    const want = this.mesh.state?.photoHash ?? null;
    return want !== null && this.photoHash === want ? this.photo : null;
  }

  /** A member without the signed photo asks the admin for it, once per hash. */
  private maybeRequestPhoto(): void {
    const state = this.mesh.state;
    const want = state?.photoHash ?? null;
    if (!state || !want || this.closed || !this.view.joined || state.creatorDid === this.myDid) return;
    if (this.photoHash === want || this.photoAsked === want) return;
    const admin = state.creatorDid;
    if (!this.links.has(admin)) return;
    this.photoAsked = want;
    this.photoFrom = admin;
    this.links.get(admin)!.receiver = new PhotoReceiver();
    void this.mesh.requestPhoto(admin, want).catch(() => {
      this.photoAsked = null;
      this.photoFrom = null;
    });
  }

  private onPhotoFrame(from: string, entry: LinkEntry, plaintext: string): void {
    // Only the link the photo was asked from may send one.
    if (this.photoFrom !== from) return;
    const result = entry.receiver.feed(plaintext);
    const stop = (reason?: string) => {
      this.photoFrom = null;
      entry.receiver = new PhotoReceiver();
      this.view = { ...this.view, photoProgress: null };
      if (reason) this.notice(reason);
      else this.refresh();
    };
    if (result.kind === "progress") {
      if (result.total > chunkCount(MAX_GROUP_PHOTO_BYTES)) {
        stop("Снимката на групата е твърде голяма.");
        return;
      }
      this.view = { ...this.view, photoProgress: { done: result.received, total: result.total } };
      this.refresh();
      return;
    }
    if (result.kind === "rejected") {
      stop(result.reason);
      return;
    }
    if (result.kind !== "photo") return;
    const want = this.mesh.state?.photoHash ?? null;
    if (want === null || photoUrlHash(result.dataUrl) !== want) {
      stop("Снимката не съвпада с подписа на създателя. Отхвърлена е.");
      return;
    }
    this.photo = result.dataUrl;
    this.photoHash = want;
    stop();
    this.persist();
  }

  private sendPhotoTo(did: string, hash: string): void {
    const photo = this.currentPhoto();
    const entry = this.links.get(did);
    if (!photo || this.photoHash !== hash || !entry) return;
    const key = `${did}|${hash}`;
    const sent = this.photoSends.get(key) ?? 0;
    if (sent >= MAX_PHOTO_SENDS) return;
    this.photoSends.set(key, sent + 1);
    const bytes = dataUrlBytes(photo);
    const mime = sniffMime(bytes);
    if (!mime) return;
    for (const frame of buildPhotoFrames(bytes, mime)) {
      void this.sendOn(entry, frame)
        .then(() => entry.link.waitForDrain?.())
        .catch(() => undefined);
    }
  }

  /* ---------- storage ---------- */

  /** Queues an encrypted save of the group, if anything changed since the last one. */
  private persist(): void {
    const key = this.historyKey;
    if (!key) return;
    this.saveQueue = this.saveQueue
      .then(async () => {
        const secrets = this.mesh.exportSecrets();
        if (!secrets) return;
        const photo = this.currentPhoto();
        const fingerprint = `${JSON.stringify(secrets)}|${photo ? this.photoHash : ""}`;
        if (fingerprint === this.savedFingerprint) return;
        await saveGroup(key, secrets, photo);
        this.savedFingerprint = fingerprint;
      })
      .catch(() => this.notice("Групата не можа да се запази на това устройство."));
  }

  private onRemoved(): void {
    this.view = { ...this.view, removed: true, photoProgress: null };
    this.photo = null;
    this.photoHash = null;
    this.linker?.close();
    const groupId = this.groupId;
    if (this.historyKey && groupId) {
      // The keys of a group this device left must not stay on disk. The history goes with them.
      this.saveQueue = this.saveQueue
        .then(() => deleteGroup(this.historyKey!, groupId))
        .catch(() => this.notice("Групата не можа да се изтрие от това устройство."));
    }
    this.notice("Бяхте махнат от групата. Ключовете и историята ѝ са изтрити от това устройство.");
  }

  private addMessage(from: string, text: string, mine: boolean): void {
    const message: GroupMessageView = { id: this.nextId++, from, text, mine, at: Date.now() };
    this.view = { ...this.view, messages: [...this.view.messages, message] };
    const key = this.historyKey;
    const groupId = this.groupId;
    if (key && groupId) {
      this.saveQueue = this.saveQueue
        .then(() => appendGroupMessage(key, groupId, { from, text, at: message.at }))
        .catch(() => this.notice("Съобщението не можа да се запази на това устройство."));
    }
    this.refresh();
  }

  private notice(text: string, vars?: Vars): void {
    this.view = { ...this.view, notices: [...this.view.notices.slice(-4), vars ? { text, vars } : { text }] };
    this.refresh();
  }

  private refresh(): void {
    const state = this.mesh.state;
    if (state) this.groupId = state.groupId;
    const linking = this.linker ? (state?.members ?? []).map((m) => m.did).filter((d) => this.linker!.isBusy(d)) : [];
    this.view = {
      ...this.view,
      state,
      isAdmin: this.mesh.isAdmin,
      linked: [...this.links.keys()],
      unverified: [...this.links.values()].filter((e) => !e.contact.verified).map((e) => e.contact.did),
      linking,
      joined: this.mesh.state !== null && this.view.joined,
      photo: this.currentPhoto(),
    };
    for (const fn of this.subscribers) fn();
  }

  /**
   * Seals and sends on one link. The responder of a link cannot send before the initiator's
   * first message has arrived (Double Ratchet); then it waits for it, up to a limit.
   */
  private sendOn(entry: LinkEntry, plaintext: string): Promise<void> {
    return this.enqueueSend(entry, async () => {
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
  }

  /* Per link: the ratchet of each session needs its own order, and one slow link must not hold up the others. */
  private enqueueSend<T>(entry: LinkEntry, task: () => Promise<T>): Promise<T> {
    const next = entry.sendQueue.then(task, task);
    entry.sendQueue = next.catch(() => undefined);
    return next;
  }

  private enqueueReceive<T>(entry: LinkEntry, task: () => Promise<T>): Promise<T> {
    const next = entry.recvQueue.then(task, task);
    entry.recvQueue = next.catch(() => undefined);
    return next;
  }
}

export type { GroupWire };
