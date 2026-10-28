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
import { bytesToBase64Url } from "../p2p/encoding";
import { buildPhotoFrames, chunkCount, FRAME_MARK, PhotoReceiver, sanitizeText, sniffMime, toDataUrl } from "../p2p/photo";
import { FileTransfers, isFileFrame, MAX_GROUP_FILE_BYTES, type FileMeta } from "../p2p/fileTransfer";
import { canStore, deleteFilesFor, loadFile, saveFile } from "../history/fileStore";
import { validFileCard, type FileCard } from "../history/messageStore";
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
/** A file card in the local group history. Only written by this device (received texts lose \u0001). */
const FILE_CARD_MARK = `${FRAME_MARK}C|`;

/** Where this group's kept files live in the file store. */
export function groupFileOwner(groupId: string): string {
  return `group:${groupId}`;
}

function parseCard(text: string): FileCard | undefined {
  if (!text.startsWith(FILE_CARD_MARK)) return undefined;
  try {
    return validFileCard(JSON.parse(text.slice(FILE_CARD_MARK.length)) as FileCard) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A file on its way to or from one member. */
export interface GroupTransfer {
  /** The member on the other end of this link. */
  peer: string;
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  phase: "offer" | "waiting" | "moving";
  done: number;
}

export interface GroupMessageView {
  id: number;
  from: string;
  text: string;
  /** A file instead of text. */
  file?: FileCard;
  mine: boolean;
  at: number;
}

/** A notice in Bulgarian source text with its placeholders, translated by the screen. */
export interface GroupNotice {
  text: string;
  vars?: Vars;
}

/** A message from another member, for sounds and notifications (App.tsx -> src/notify). */
export interface GroupIncoming {
  groupId: string | null;
  groupName: string;
  from: string;
  /** The name the group knows the sender by. */
  fromName: string;
  text: string;
  file?: FileCard;
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
  /** Files offered to this device, and files moving in either direction. */
  transfers: GroupTransfer[];
  /** Object URLs of files sent or received in this session, by file id. */
  fileUrls: Record<string, string>;
}

/** What the group needs from a link. PeerLink has all of it. */
export type GroupLink = Pick<PeerLink, "send" | "onMessage" | "close"> &
  Partial<Pick<PeerLink, "waitForDrain" | "isOpen" | "sendBinary" | "onBinary">>;

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
  /** File transfers on this link, when the link carries binary messages. */
  files: FileTransfers | null;
  offBinary: () => void;
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
  private readonly incoming = new Set<(m: GroupIncoming) => void>();
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
      // \u0001 is dropped from received text, so nobody can pose a text as a file card.
      message: (from, text) => this.addMessage(from, sanitizeText(text), from === this.myDid),
      membership: () => {
        // Someone was removed: close the direct link to them, so nothing more goes either way.
        // Invitees and introduced candidates are not members yet and keep their links.
        for (const did of [...this.links.keys()]) {
          if (!this.mesh.isKnownPeer(did) && !this.mesh.isInvitee(did)) this.drop(did);
        }
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
    const messages = (options.history ?? []).map((h) => {
      const file = parseCard(h.text);
      return { id: this.nextId++, from: h.from, text: file ? "" : h.text, file, mine: h.from === this.myDid, at: h.at };
    });
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
      transfers: [],
      fileUrls: {},
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

  /** Called for every text or file another member sends (not for this device's own messages). */
  onIncoming(fn: (m: GroupIncoming) => void): () => void {
    this.incoming.add(fn);
    return () => this.incoming.delete(fn);
  }

  private emitIncoming(from: string, text: string, file?: FileCard): void {
    const state = this.mesh.state;
    const m: GroupIncoming = {
      groupId: state?.groupId ?? this.groupId,
      groupName: state?.name ?? "",
      from,
      fromName: state?.members.find((x) => x.did === from)?.name ?? "",
      text,
      ...(file ? { file } : {}),
    };
    for (const fn of this.incoming) {
      try {
        fn(m);
      } catch {
        /* a listener's problem must not stop the group */
      }
    }
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
      old.offBinary();
      old.files?.close();
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
      files: null,
      offBinary: () => undefined,
    };
    if (link.sendBinary && link.onBinary) {
      entry.files = this.filesFor(contact.did, entry);
      const files = entry.files;
      entry.offBinary = link.onBinary((bytes) => {
        files.handleBinary(bytes);
      });
    }
    entry.unsubscribe = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void this.enqueueReceive(entry, async () => {
        const plaintext = await session.open(text);
        // The first message from the peer also starts this side's sending chain.
        markReady();
        if (isGroupWire(plaintext)) {
          await this.mesh.handle(contact.did, plaintext);
          this.persist();
        } else if (isFileFrame(plaintext)) {
          entry.files?.handleControl(plaintext);
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
    entry.offBinary();
    entry.files?.close();
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
    const later = await this.mesh.drop(did);
    this.drop(did);
    this.persist();
    if (later.length === 0) this.notice("Участникът е махнат. Новият ключ е раздаден на останалите.");
    else this.notice("Участникът е махнат. Офлайн участниците ще получат новия ключ, когато се свържат.");
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

  /* ---------- files ---------- */

  /**
   * Sends a file (up to 50 MB) to every member this device is linked to right now. Each link
   * gets its own offer and its own key inside that pairwise session, so only the members of
   * this moment can receive it: someone who joins later never gets the key. Every recipient
   * decides whether to take it. Resolves with how many members got the whole file.
   */
  async sendFile(blob: Blob, name: string): Promise<{ delivered: number; offered: number }> {
    const state = this.mesh.state;
    if (!state || !this.view.joined) throw new Error("Още няма група.");
    if (blob.size > MAX_GROUP_FILE_BYTES) throw new Error("Файлът е твърде голям.");
    const targets = [...this.links.values()].filter(
      (e) => e.files && e.contact.did !== this.myDid && state.members.some((m) => m.did === e.contact.did),
    );
    if (targets.length === 0) throw new Error("Няма свързани участници.");
    const results = await Promise.allSettled(targets.map((e) => e.files!.send(blob, name)));
    const metas = results.filter((r): r is PromiseFulfilledResult<FileMeta> => r.status === "fulfilled").map((r) => r.value);
    if (metas.length > 0) {
      // One card in our own history, under an id of our own (each recipient got its own id).
      const meta = { ...metas[0], id: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(8))) };
      const card = await this.keepFile(meta, new Blob([blob], { type: meta.mime }));
      this.addFileMessage(this.myDid, card, true);
    }
    return { delivered: metas.length, offered: targets.length };
  }

  /** A kept file of this group, or null. */
  async loadFile(id: string): Promise<Blob | null> {
    if (!this.historyKey || !this.groupId) return null;
    return loadFile(this.historyKey, groupFileOwner(this.groupId), id);
  }

  async acceptFile(peer: string, id: string): Promise<void> {
    await this.links.get(peer)?.files?.accept(id);
  }

  async cancelFile(peer: string, id: string): Promise<void> {
    this.setTransfers(this.view.transfers.filter((t) => !(t.peer === peer && t.id === id)));
    await this.links.get(peer)?.files?.cancel(id);
  }

  private filesFor(peer: string, entry: LinkEntry): FileTransfers {
    const upsert = (t: GroupTransfer) =>
      this.setTransfers([...this.view.transfers.filter((x) => !(x.peer === t.peer && x.id === t.id)), t]);
    const remove = (id: string) => this.setTransfers(this.view.transfers.filter((x) => !(x.peer === peer && x.id === id)));
    const isMemberNow = () => this.mesh.state?.members.some((m) => m.did === peer) ?? false;
    return new FileTransfers(
      { sendControl: (pt) => this.sendOn(entry, pt), sendBinary: (bytes) => entry.link.sendBinary!(bytes) },
      {
        offered: (m) => {
          // Only members may send files; a candidate or a removed member is refused at once.
          if (!isMemberNow() || !this.view.joined) {
            void entry.files?.cancel(m.id);
            return;
          }
          upsert({ peer, id: m.id, name: m.name, size: m.size, direction: "in", phase: "offer", done: 0 });
        },
        outgoing: (m) => upsert({ peer, id: m.id, name: m.name, size: m.size, direction: "out", phase: "waiting", done: 0 }),
        progress: (id, done) =>
          this.setTransfers(this.view.transfers.map((x) => (x.peer === peer && x.id === id ? { ...x, phase: "moving", done } : x))),
        received: (meta, blob) => {
          remove(meta.id);
          if (!isMemberNow()) return; // removed while the file was on its way
          void this.keepFile(meta, blob).then((card) => this.addFileMessage(peer, card, false));
        },
        sent: (meta) => remove(meta.id),
        failed: (id, reason, direction) => {
          remove(id);
          if (direction === "in" && reason !== "Отказано.") this.notice(reason);
        },
      },
      MAX_GROUP_FILE_BYTES,
    );
  }

  private setTransfers(transfers: GroupTransfer[]): void {
    this.view = { ...this.view, transfers };
    this.refresh();
  }

  /** Keeps a file up to 25 MB encrypted on the device; larger ones live only in this session. */
  private async keepFile(meta: FileMeta, blob: Blob): Promise<FileCard> {
    this.view = { ...this.view, fileUrls: { ...this.view.fileUrls, [meta.id]: URL.createObjectURL(blob) } };
    let stored = canStore(meta.size) && this.historyKey !== null && this.groupId !== null;
    if (stored) {
      try {
        await saveFile(this.historyKey!, groupFileOwner(this.groupId!), meta.id, blob);
      } catch {
        stored = false;
      }
    }
    return { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, stored };
  }

  private addFileMessage(from: string, card: FileCard, mine: boolean): void {
    const message: GroupMessageView = { id: this.nextId++, from, text: "", file: card, mine, at: Date.now() };
    this.view = { ...this.view, messages: [...this.view.messages, message] };
    if (!mine) this.emitIncoming(from, "", card);
    const key = this.historyKey;
    const groupId = this.groupId;
    if (key && groupId) {
      const text = FILE_CARD_MARK + JSON.stringify(card);
      this.saveQueue = this.saveQueue
        .then(() => appendGroupMessage(key, groupId, { from, text, at: message.at }))
        .catch(() => this.notice("Съобщението не можа да се запази на това устройство."));
    }
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
        .then(() => deleteFilesFor(groupFileOwner(groupId)))
        .catch(() => this.notice("Групата не можа да се изтрие от това устройство."));
    }
    this.notice("Бяхте махнат от групата. Ключовете и историята ѝ са изтрити от това устройство.");
  }

  private addMessage(from: string, text: string, mine: boolean): void {
    const message: GroupMessageView = { id: this.nextId++, from, text, mine, at: Date.now() };
    this.view = { ...this.view, messages: [...this.view.messages, message] };
    if (!mine) this.emitIncoming(from, text);
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
