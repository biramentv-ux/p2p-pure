/**
 * Mesh router for one group, on one device.
 *
 * It knows nothing about WebRTC. The app attaches one send function per pairwise link
 * (`attach(did, send)`); `send` takes plaintext and sends it through that link's encrypted
 * session. Incoming plaintext from a link goes to `handle(from, plaintext)`.
 *
 * Joining (admin admits a candidate):
 *  1. admin -> candidate  gpend   the current signed state
 *  2. the app links the candidate to every member (the same QR/code flow as contacts)
 *  3. candidate -> admin  gjoin   signed list of the members it is linked to
 *  4. admin checks the list covers every member, then admits: gsnap + gkey to everyone
 * So a new member is never admitted before it is connected to all the others.
 *
 * Removing: the admin sends a new snapshot and a new key to the members who stay, and
 * a snapshot to the removed member, who then sees that it is no longer a member.
 *
 * Auto-linking (step 2 without QR codes):
 *  - admin -> member  gintro  "link with <peer>", signed by the admin. Sent to every member
 *    for a new candidate, to a new member for candidates still waiting, and to a member that
 *    links to the admin again (after a reload) for every other member the admin is linked to.
 *  - member -> admin -> peer  grelay  a WebRTC invitation (offer, then answer) signed by its
 *    real sender (p2p/invitation.ts). The admin only forwards it and sets `from`.
 *  - The receiver accepts a relayed invitation only from the admin's link, only if `from` is
 *    a member of the signed state (or a candidate the admin introduced with a valid gintro),
 *    and the app then checks the invitation's signature against `from` (groupLinker.ts).
 *    The admin can refuse to forward, but it cannot forge another member's invitation.
 */
import type { DidKey, Ed25519KeyPair } from "../identity/types";
import { base64UrlToBytes, bytesToBase64Url } from "../p2p/encoding";
import type { CipherSuite } from "../p2p/cipherSuite";
import { newProposalId } from "../p2p/suiteNegotiation";
import {
  verifyIntro,
  verifyVoteOpen,
  decodeGroupWire,
  encodeGroupWire,
  GroupChat,
  signJoinRequest,
  verifyJoinRequest,
  verifyStateSignature,
  type GroupSecrets,
  type GroupWire,
} from "./groupChat";
import { GroupError, isMember, type GroupState } from "./groupModel";
import { publicKeyToDidKey } from "../identity/didKey";

export interface MeshEvents {
  /** A decrypted group message, with the sender's DID. */
  message(from: DidKey, text: string): void;
  /** The member list, name or suite changed. */
  membership(state: GroupState): void;
  /** The admin asks this member to approve a cipher-suite change. Answer with answerSuite. */
  suiteRequested(suite: CipherSuite): void;
  /** The cipher suite was changed by a completed vote. */
  suite(suite: CipherSuite): void;
  /** A candidate: waiting for links to the members, or for admission. */
  pending(): void;
  /** A candidate: admitted, the chat is ready. */
  joined(): void;
  /** This device was removed from the group. */
  removed(): void;
  /** Something was refused or could not be sent. */
  error(message: string): void;
  /** The admin asks this device to make a link to `peer` (auto-linking). */
  introduced?(peer: DidKey, name: string): void;
  /**
   * A WebRTC invitation from `from`, forwarded by the admin. `from` is a member or an
   * introduced candidate; the invitation's own signature is still to be checked.
   */
  relayed?(from: DidKey, invitation: string): void;
  /** `from` (a member) asks for the group photo with this hash. */
  photoRequested?(from: DidKey, hash: string): void;
}

export type LinkSend = (plaintext: string) => Promise<void> | void;

type Snapshot = GroupWire & { t: "gsnap" };

export class GroupMesh {
  private readonly links = new Map<DidKey, LinkSend>();
  private readonly invitees = new Map<DidKey, string>();
  /** Candidates the admin introduced to this member (signed gintro), with their expiry. */
  private readonly intros = new Map<DidKey, { name: string; exp: number }>();
  private chat: GroupChat | null;
  private pendingState: GroupState | null = null;
  private pendingSnapshot: Snapshot | null = null;
  private joinSent = false;
  /** A suite vote opened by the admin and waiting for this member's answer. */
  private openVote: (GroupWire & { t: "gvote"; op: "open" }) | null = null;
  readonly myDid: DidKey;
  private readonly keys: Ed25519KeyPair;
  private readonly events: MeshEvents;

  constructor(keys: Ed25519KeyPair, events: MeshEvents, chat: GroupChat | null = null) {
    this.keys = keys;
    this.events = events;
    this.chat = chat;
    this.myDid = publicKeyToDidKey(keys.publicKey);
  }

  /** The group as this device knows it: the full state, or the pending state for a candidate. */
  get state(): GroupState | null {
    return this.chat?.snapshot ?? this.pendingState;
  }

  get isAdmin(): boolean {
    return this.chat !== null && this.chat.isAdmin;
  }

  get linkedDids(): DidKey[] {
    return [...this.links.keys()];
  }

  /** Members (other than this device) with no link yet. */
  missingLinks(): DidKey[] {
    const state = this.state;
    if (!state) return [];
    return state.members.map((m) => m.did).filter((d) => d !== this.myDid && !this.links.has(d));
  }

  /** The record to save between sessions, or null when this device is not (or no longer) a member. */
  exportSecrets(): GroupSecrets | null {
    return this.chat?.exportSecrets() ?? null;
  }

  /**
   * Registers a pairwise link. Candidates may send their join request now. When a member
   * links to the admin (again), the admin asks it to link with the other members.
   */
  attach(did: DidKey, send: LinkSend): void {
    this.links.set(did, send);
    void this.maybeRequestJoin();
    if (this.isAdmin && did !== this.myDid && isMember(this.chat!.snapshot, did)) {
      void this.welcomeBack(did).catch(() => undefined);
    }
  }

  /**
   * Admin: a member linked again (after a reload, or a lost link). It may have missed changes
   * while it was away, so it gets the current snapshot and key, then the introductions.
   */
  private async welcomeBack(did: DidKey): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    const epoch = chat.snapshot.epoch;
    const key = chat.keyFor(epoch);
    await this.sendTo(did, chat.signedSnapshot());
    if (key) await this.sendTo(did, { t: "gkey", g: chat.snapshot.groupId, e: epoch, key: bytesToBase64Url(key) });
    await this.introduceOthersTo(did);
  }

  detach(did: DidKey): void {
    this.links.delete(did);
  }

  /** Admin: starts the join of a candidate who is already linked to this device. */
  async invite(did: DidKey, name: string): Promise<void> {
    this.requireAdmin();
    if (!this.links.has(did)) throw new GroupError("not-member", "Първо свържете този човек.");
    this.invitees.set(did, name);
    const snap = this.chat!.signedSnapshot();
    await this.sendTo(did, { t: "gpend", state: snap.state, sig: snap.sig });
    // Ask every linked member to link with the candidate, so nobody has to scan a QR code.
    for (const m of this.chat!.snapshot.members) {
      if (m.did === this.myDid || m.did === did || !this.links.has(m.did)) continue;
      await this.sendTo(m.did, this.chat!.signIntro(did, name)).catch(() => undefined);
    }
  }

  /** Admin: sends a member signed introductions to the other linked members and the waiting candidates. */
  private async introduceOthersTo(did: DidKey): Promise<void> {
    const chat = this.chat;
    if (!chat) return;
    for (const m of chat.snapshot.members) {
      if (m.did === this.myDid || m.did === did || !this.links.has(m.did)) continue;
      await this.sendTo(did, chat.signIntro(m.did, m.name));
    }
    for (const [candidate, name] of this.invitees) {
      if (candidate === did || !this.links.has(candidate)) continue;
      await this.sendTo(did, chat.signIntro(candidate, name));
    }
  }

  /**
   * A member or candidate: sends a signed WebRTC invitation to `to` through the admin.
   * The admin itself never needs this: it is linked to everyone directly.
   */
  async relay(to: DidKey, invitation: string): Promise<void> {
    const state = this.state;
    if (!state) throw new GroupError("not-member", "Още няма група.");
    if (this.isAdmin) throw new GroupError("not-admin", "Създателят се свързва директно.");
    await this.sendTo(state.creatorDid, { t: "grelay", g: state.groupId, to, inv: invitation });
  }

  /** Asks `to` for the group photo with this hash. */
  async requestPhoto(to: DidKey, hash: string): Promise<void> {
    const state = this.state;
    if (!state) return;
    await this.sendTo(to, { t: "gphoto", g: state.groupId, h: hash });
  }

  /** Admin: sets or clears the group photo hash and sends the new snapshot to everyone. */
  async setPhoto(hash: string | null): Promise<void> {
    this.requireAdmin();
    const snapshot = this.chat!.setPhoto(hash);
    await this.broadcast(snapshot);
    this.events.membership(this.chat!.snapshot);
  }

  /** A member of the signed state, or a candidate the admin introduced and whose introduction is still valid. */
  isKnownPeer(did: DidKey, now = Date.now()): boolean {
    const state = this.state;
    if (!state || did === this.myDid) return false;
    if (isMember(state, did)) return true;
    const intro = this.intros.get(did);
    return intro !== undefined && intro.exp > now;
  }

  /** Admin: someone invited who has not joined yet. */
  isInvitee(did: DidKey): boolean {
    return this.invitees.has(did);
  }

  /** The name the group knows a peer by: from the signed state, or from the admin's introduction. */
  peerName(did: DidKey): string | undefined {
    return this.state?.members.find((m) => m.did === did)?.name ?? this.intros.get(did)?.name;
  }

  private isMemberOrInvitee(did: DidKey): boolean {
    return this.chat !== null && (isMember(this.chat.snapshot, did) || this.invitees.has(did));
  }

  /** Admin: sends a text message to every linked member. */
  async sendMessage(text: string): Promise<void> {
    if (!this.chat) throw new GroupError("not-member", "Още не сте в групата.");
    const wire = await this.chat.seal(text);
    await this.broadcast(wire);
  }

  /** Admin: opens a cipher-suite vote. Members approve; the change applies when all have. */
  async openSuite(suite: CipherSuite): Promise<void> {
    this.requireAdmin();
    const wire = this.chat!.openSuiteVote(newProposalId(), suite);
    await this.broadcast(wire);
  }

  /** Member: answers the admin's open suite vote. Approval is never automatic. */
  async answerSuite(accept: boolean): Promise<void> {
    const open = this.openVote;
    if (!open || !this.chat) throw new GroupError("stale", "Няма предложение за смяна.");
    this.openVote = null;
    if (!accept) return;
    const approval = this.chat.approveSuiteVote(open);
    await this.sendTo(this.adminDid(), approval);
  }

  /**
   * Admin: removes a member and rotates the key for the rest. Nobody has to be online: the
   * removed member gets nothing new, and a remaining member who is offline receives the new
   * snapshot and key when it links to the admin again (welcomeBack). Returns the members who
   * could not be told right now.
   */
  async drop(did: DidKey): Promise<DidKey[]> {
    this.requireAdmin();
    const { snapshot, keyFor } = this.chat!.dropMember(did);
    const removedLink = this.links.get(did);
    this.links.delete(did);
    const later: DidKey[] = [];
    for (const [member, wire] of keyFor) {
      if (!this.links.has(member)) {
        later.push(member);
        continue;
      }
      try {
        await this.sendTo(member, snapshot);
        await this.sendTo(member, wire);
      } catch {
        later.push(member);
      }
    }
    // Courtesy only: if the removed member is online it learns at once. Its key is useless anyway.
    if (removedLink) await Promise.resolve(removedLink(encodeGroupWire(snapshot))).catch(() => undefined);
    this.events.membership(this.chat!.snapshot);
    return later;
  }

  /** Handles one decrypted plaintext from the link to `from`. Errors are reported, not thrown. */
  async handle(from: DidKey, plaintext: string): Promise<void> {
    const wire = decodeGroupWire(plaintext);
    if (!wire) return;
    try {
      await this.dispatch(from, wire);
    } catch (err) {
      if (err instanceof GroupError && err.code === "stale") return; // old or repeated: ignore quietly
      this.events.error(err instanceof Error ? err.message : "Съобщението не беше прието.");
    }
  }

  private async dispatch(from: DidKey, wire: GroupWire): Promise<void> {
    switch (wire.t) {
      case "gpend": {
        if (this.chat || from !== wire.state.creatorDid || !verifyStateSignature(wire)) return;
        const before = this.pendingState;
        if (before && before.groupId === wire.state.groupId && wire.state.version <= before.version) return;
        // A newer member list (someone else was admitted meanwhile): the join request is sent again.
        if (before) this.joinSent = false;
        this.pendingState = wire.state;
        this.events.pending();
        await this.maybeRequestJoin();
        return;
      }
      case "gjoin": {
        if (!this.isAdmin || wire.f !== from || !verifyJoinRequest(wire)) return;
        const name = this.invitees.get(from);
        if (name === undefined) return;
        const members = this.chat!.snapshot.members.map((m) => m.did).filter((d) => d !== this.myDid && d !== from);
        const missing = members.filter((d) => !wire.linked.includes(d));
        if (missing.length > 0) {
          this.events.error("Новият участник още не е свързан с всички в групата.");
          return;
        }
        this.invitees.delete(from);
        await this.admit(from, name);
        return;
      }
      case "gsnap": {
        if (from !== this.adminDid() || !verifyStateSignature(wire)) return;
        if (this.chat) {
          const before = this.chat.snapshot.suite;
          const was = this.chat.snapshot.members.map((m) => m.did);
          this.chat.receiveSnapshot(wire);
          // A removed member's old introduction must not keep it trusted as a candidate.
          for (const did of was) if (!isMember(this.chat.snapshot, did)) this.intros.delete(did);
          if (!isMember(wire.state, this.myDid)) {
            this.chat = null;
            this.intros.clear();
            this.events.removed();
            return;
          }
          if (this.chat.snapshot.suite !== before) this.events.suite(this.chat.snapshot.suite);
          this.events.membership(this.chat.snapshot);
        } else if (wire.state.members.some((m) => m.did === this.myDid)) {
          this.pendingSnapshot = wire;
        }
        return;
      }
      case "gkey": {
        if (from !== this.adminDid()) return;
        if (this.chat) {
          this.chat.receiveKey(from, wire);
          return;
        }
        if (this.pendingSnapshot && wire.g === this.pendingSnapshot.state.groupId) {
          const snapshot = this.pendingSnapshot;
          this.pendingSnapshot = null;
          this.chat = GroupChat.join(this.keys, snapshot, {
            epoch: wire.e,
            key: base64UrlToBytes(wire.key),
          });
          this.pendingState = null;
          this.events.joined();
          this.events.membership(this.chat.snapshot);
        }
        return;
      }
      case "gmsg": {
        if (!this.chat || wire.f !== from) return;
        const text = await this.chat.open(wire);
        this.events.message(wire.f, text);
        return;
      }
      case "gvote": {
        if (!this.chat) return;
        if (wire.op === "open") {
          if (from !== this.adminDid() || !verifyVoteOpen(wire, from)) return;
          this.openVote = wire;
          this.events.suiteRequested(wire.suite);
          return;
        }
        if (!this.isAdmin || wire.f !== from) return;
        const snapshot = this.chat!.receiveApproval(wire);
        if (snapshot) {
          await this.broadcast(snapshot);
          this.events.suite(this.chat!.snapshot.suite);
          this.events.membership(this.chat!.snapshot);
        }
        return;
      }
      case "gintro": {
        const chat = this.chat;
        if (!chat || this.isAdmin || from !== chat.snapshot.creatorDid || wire.g !== chat.snapshot.groupId) return;
        if (wire.peer === this.myDid || wire.peer === chat.snapshot.creatorDid) return;
        if (!verifyIntro(wire, chat.snapshot.creatorDid)) return;
        this.intros.set(wire.peer, { name: wire.name, exp: wire.exp });
        this.events.introduced?.(wire.peer, wire.name);
        return;
      }
      case "grelay": {
        const state = this.state;
        if (!state || wire.g !== state.groupId) return;
        if (this.isAdmin) {
          // Forward only between members and invited candidates. Only the admin sets `from`.
          if (wire.from !== undefined || wire.to === from || wire.to === this.myDid) return;
          if (!this.isMemberOrInvitee(from) || !this.isMemberOrInvitee(wire.to)) {
            this.events.error("Покана между хора извън групата не беше препратена.");
            return;
          }
          if (!this.links.has(wire.to)) {
            this.events.error("Няма връзка с участника, за когото е поканата.");
            return;
          }
          await this.sendTo(wire.to, { t: "grelay", g: wire.g, to: wire.to, from, inv: wire.inv });
          return;
        }
        if (from !== state.creatorDid || wire.to !== this.myDid || wire.from === undefined) return;
        if (wire.from === this.myDid || wire.from === state.creatorDid) return;
        if (!this.isKnownPeer(wire.from)) {
          this.events.error("Покана от човек извън групата беше отказана.");
          return;
        }
        this.events.relayed?.(wire.from, wire.inv);
        return;
      }
      case "gphoto": {
        const chat = this.chat;
        if (!chat || wire.g !== chat.snapshot.groupId || !isMember(chat.snapshot, from)) return;
        this.events.photoRequested?.(from, wire.h);
        return;
      }
      default:
        return;
    }
  }

  /** Admin: a member is admitted. Everyone gets the new snapshot; the new member gets its key too. */
  private async admit(did: DidKey, name: string): Promise<void> {
    const { snapshot, keyFor } = this.chat!.admitMember({ did, name });
    for (const [member, wire] of keyFor) {
      await this.sendTo(member, snapshot);
      await this.sendTo(member, wire);
    }
    this.events.membership(this.chat!.snapshot);
    // Candidates still waiting must link with the new member too: they get the new member
    // list, and the new member is asked to link with them.
    for (const [candidate, candidateName] of this.invitees) {
      if (!this.links.has(candidate)) continue;
      await this.sendTo(candidate, { t: "gpend", state: snapshot.state, sig: snapshot.sig }).catch(() => undefined);
      await this.sendTo(did, this.chat!.signIntro(candidate, candidateName)).catch(() => undefined);
    }
  }

  /** Candidate: once linked to every member, tell the admin. Sent once per pending state. */
  private async maybeRequestJoin(): Promise<void> {
    if (this.chat || !this.pendingState || this.joinSent) return;
    if (this.missingLinks().length > 0) return;
    const admin = this.pendingState.creatorDid;
    if (!this.links.has(admin)) return;
    this.joinSent = true;
    await this.sendTo(admin, signJoinRequest(this.keys, this.pendingState.groupId, this.linkedDids));
  }

  private adminDid(): DidKey {
    const state = this.state;
    if (!state) throw new GroupError("not-member", "Още няма група.");
    return state.creatorDid;
  }

  private requireAdmin(): void {
    if (!this.isAdmin) throw new GroupError("not-admin", "Само създателят може да прави това.");
  }

  private async sendTo(did: DidKey, wire: GroupWire): Promise<void> {
    const send = this.links.get(did);
    if (!send) throw new GroupError("not-member", "Няма връзка с този участник.");
    await send(encodeGroupWire(wire));
  }

  /** Best effort: a missing or failed link does not stop the others. */
  private async broadcast(wire: GroupWire): Promise<void> {
    for (const did of [...this.links.keys()]) {
      try {
        await this.sendTo(did, wire);
      } catch {
        this.events.error("Съобщението не стигна до всички връзки.");
      }
    }
  }
}
