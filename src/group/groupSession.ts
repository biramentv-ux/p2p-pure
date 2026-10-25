/**
 * Live state of one group on this device: the mesh router, one pairwise link per member,
 * the messages and notices shown to the user, and the subscribers that re-render the UI.
 *
 * Each pairwise link here is a link of its own, made with the normal connect flow. It is
 * not shared with the one-to-one chats, so opening a chat never changes group traffic.
 *
 * Ratchet ordering: sends and receives run in two separate queues. A receive can trigger a
 * send (the mesh answers a join or a vote), and a single queue would wait for itself.
 */
import type { Contact } from "../contacts/contacts";
import type { Ed25519KeyPair } from "../identity/types";
import type { PeerLink } from "../p2p/peer";
import { isEncryptedMessage, type SecureSession } from "../p2p/secureSession";
import type { CipherSuite } from "../p2p/cipherSuite";
import { isGroupWire, type GroupWire } from "./groupChat";
import { GroupChat } from "./groupChat";
import { GroupMesh, type MeshEvents } from "./groupMesh";
import type { GroupState } from "./groupModel";

export interface GroupMessageView {
  id: number;
  from: string;
  text: string;
  mine: boolean;
  at: number;
}

export interface GroupView {
  state: GroupState | null;
  isAdmin: boolean;
  linked: string[];
  messages: GroupMessageView[];
  notices: string[];
  /** A suite change this member is asked to approve. */
  suiteRequest: CipherSuite | null;
  joined: boolean;
  removed: boolean;
  pending: boolean;
}

interface LinkEntry {
  contact: Contact;
  link: PeerLink;
  session: SecureSession;
  unsubscribe: () => void;
}

export class GroupSession {
  private readonly mesh: GroupMesh;
  private readonly links = new Map<string, LinkEntry>();
  private readonly subscribers = new Set<() => void>();
  private sendQueue: Promise<unknown> = Promise.resolve();
  private recvQueue: Promise<unknown> = Promise.resolve();
  private view: GroupView;
  private nextId = 1;
  private readonly myDid: string;

  constructor(keys: Ed25519KeyPair, chat: GroupChat | null = null) {
    const events: MeshEvents = {
      message: (from, text) => this.addMessage(from, text, from === this.myDid),
      membership: () => this.refresh(),
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
      },
      removed: () => {
        this.view = { ...this.view, removed: true };
        this.notice("Бяхте махнат от групата.");
      },
      error: (message) => this.notice(message),
    };
    this.mesh = new GroupMesh(keys, events, chat);
    this.myDid = this.mesh.myDid;
    this.view = {
      state: null,
      isAdmin: false,
      linked: [],
      messages: [],
      notices: [],
      suiteRequest: null,
      joined: chat !== null,
      removed: false,
      pending: false,
    };
    this.refresh();
  }

  get me(): string {
    return this.myDid;
  }

  /** Snapshot for rendering. A new object each time something changed. */
  get snapshot(): GroupView {
    return this.view;
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** The verified contact behind a linked member, if this device has a link to it. */
  contactOf(did: string): Contact | undefined {
    return this.links.get(did)?.contact;
  }

  isLinked(did: string): boolean {
    return this.links.has(did);
  }

  /** Attaches a freshly connected pairwise link to the mesh. Replaces an older link to the same person. */
  attach(contact: Contact, link: PeerLink, session: SecureSession): void {
    const old = this.links.get(contact.did);
    if (old) {
      old.unsubscribe();
      old.link.close();
      this.mesh.detach(contact.did);
    }
    const unsubscribe = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void this.enqueueReceive(async () => {
        const plaintext = await session.open(text);
        if (isGroupWire(plaintext)) await this.mesh.handle(contact.did, plaintext);
      }).catch(() => this.notice("Съобщение от участник не можа да се прочете."));
    });
    this.links.set(contact.did, { contact, link, session, unsubscribe });
    this.mesh.attach(contact.did, (plaintext) =>
      this.enqueueSend(async () => {
        link.send(await session.seal(plaintext));
      }),
    );
    this.refresh();
  }

  /** Closes the link to one person. */
  drop(did: string): void {
    const entry = this.links.get(did);
    if (!entry) return;
    entry.unsubscribe();
    entry.link.close();
    this.links.delete(did);
    this.mesh.detach(did);
    this.refresh();
  }

  closeAll(): void {
    for (const did of [...this.links.keys()]) this.drop(did);
  }

  /** Creator only: starts a group with this device as the admin. */
  static create(keys: Ed25519KeyPair, groupId: string, name: string, creatorName: string): GroupSession {
    return new GroupSession(keys, GroupChat.create(keys, groupId, name, creatorName));
  }

  async invite(did: string, name: string): Promise<void> {
    await this.mesh.invite(did, name);
    this.notice(`Поканен е ${name}.`);
  }

  async remove(did: string): Promise<void> {
    await this.mesh.drop(did);
    this.drop(did);
    this.notice("Участникът е махнат. Новият ключ е раздаден на останалите.");
  }

  async sendText(text: string): Promise<void> {
    await this.mesh.sendMessage(text);
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

  private addMessage(from: string, text: string, mine: boolean): void {
    const message: GroupMessageView = { id: this.nextId++, from, text, mine, at: Date.now() };
    this.view = { ...this.view, messages: [...this.view.messages, message] };
    this.refresh();
  }

  private notice(text: string): void {
    this.view = { ...this.view, notices: [...this.view.notices.slice(-4), text] };
    this.refresh();
  }

  private refresh(): void {
    const state = this.mesh.state;
    this.view = {
      ...this.view,
      state,
      isAdmin: this.mesh.isAdmin,
      linked: [...this.links.keys()],
      joined: this.mesh.state !== null && this.view.joined,
    };
    for (const fn of this.subscribers) fn();
  }

  private enqueueSend<T>(task: () => Promise<T>): Promise<T> {
    const next = this.sendQueue.then(task, task);
    this.sendQueue = next.catch(() => undefined);
    return next;
  }

  private enqueueReceive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.recvQueue.then(task, task);
    this.recvQueue = next.catch(() => undefined);
    return next;
  }
}

export type { GroupWire };
