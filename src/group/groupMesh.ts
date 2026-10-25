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
 */
import type { DidKey, Ed25519KeyPair } from "../identity/types";
import { base64UrlToBytes } from "../p2p/encoding";
import type { CipherSuite } from "../p2p/cipherSuite";
import { newProposalId } from "../p2p/suiteNegotiation";
import {
  verifyVoteOpen,
  decodeGroupWire,
  encodeGroupWire,
  GroupChat,
  signJoinRequest,
  verifyJoinRequest,
  verifyStateSignature,
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
}

export type LinkSend = (plaintext: string) => Promise<void> | void;

type Snapshot = GroupWire & { t: "gsnap" };

export class GroupMesh {
  private readonly links = new Map<DidKey, LinkSend>();
  private readonly invitees = new Map<DidKey, string>();
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

  /** Registers a pairwise link. Candidates may send their join request now. */
  attach(did: DidKey, send: LinkSend): void {
    this.links.set(did, send);
    void this.maybeRequestJoin();
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

  /** Admin: removes a member and rotates the key for the rest. */
  async drop(did: DidKey): Promise<void> {
    this.requireAdmin();
    const { snapshot, keyFor } = this.chat!.dropMember(did);
    const removedLink = this.links.get(did);
    for (const [member, wire] of keyFor) {
      await this.sendTo(member, snapshot);
      await this.sendTo(member, wire);
    }
    if (removedLink) await removedLink(encodeGroupWire(snapshot));
    this.links.delete(did);
    this.events.membership(this.chat!.snapshot);
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
          this.chat.receiveSnapshot(wire);
          if (!isMember(wire.state, this.myDid)) {
            this.chat = null;
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
