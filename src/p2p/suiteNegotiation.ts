/**
 * Agreement on the cipher suite between the two people in a chat session.
 *
 * Either side may propose a suite. The proposal is shown to the other person, who
 * accepts or declines. A side switches the suite it SENDS with only at the point it
 * accepts (receiving side) or receives the acceptance of its own proposal (proposing
 * side). So a change needs a confirmation from each person, and nothing changes silently.
 *
 * Messages in flight are not a problem: the receiver reads the suite from each message
 * (its "s" field, bound into the authenticated data), so both suites are always readable.
 *
 * This module is pure state: it returns what to send and what to activate.
 */
import { isCipherSuite, type CipherSuite, DEFAULT_CIPHER_SUITE } from "./cipherSuite";

export type SuiteMessage =
  | { t: "suite"; op: "propose"; suite: CipherSuite; id: string }
  | { t: "suite"; op: "accept"; suite: CipherSuite; id: string }
  | { t: "suite"; op: "decline"; id: string };

interface Pending {
  id: string;
  suite: CipherSuite;
}

export interface NegotiationState {
  /** The suite this side currently sends with. */
  active: CipherSuite;
  /** A proposal this side made and is waiting to have accepted. */
  outgoing: Pending | null;
  /** A proposal from the other person waiting for this side's answer. */
  incoming: Pending | null;
}

export interface Step {
  state: NegotiationState;
  /** Message to send to the other person, encrypted in the chat. */
  send?: SuiteMessage;
  /** Suite to start sending with now (session.setSendSuite). */
  activate?: CipherSuite;
  /** Set when the requested change is not possible. */
  rejected?: "same-suite";
}

export function initialNegotiation(): NegotiationState {
  return { active: DEFAULT_CIPHER_SUITE, outgoing: null, incoming: null };
}

/** This side asks to change the suite. `id` must be a fresh random identifier. */
export function proposeSuite(state: NegotiationState, suite: CipherSuite, id: string): Step {
  if (suite === state.active) return { state, rejected: "same-suite" };
  return {
    state: { ...state, outgoing: { id, suite } },
    send: { t: "suite", op: "propose", suite, id },
  };
}

/** Applies a suite message received from the other person. */
export function receiveSuiteMessage(state: NegotiationState, msg: SuiteMessage): Step {
  switch (msg.op) {
    case "propose": {
      // Proposing what is already active is a no-op. Otherwise it waits for an answer.
      if (msg.suite === state.active) return { state };
      return { state: { ...state, incoming: { id: msg.id, suite: msg.suite } } };
    }
    case "accept": {
      const o = state.outgoing;
      if (!o || o.id !== msg.id || o.suite !== msg.suite) return { state };
      return { state: { ...state, active: msg.suite, outgoing: null }, activate: msg.suite };
    }
    case "decline": {
      if (state.outgoing?.id !== msg.id) return { state };
      return { state: { ...state, outgoing: null } };
    }
  }
}

/** This side answers the other person's proposal. */
export function answerIncoming(state: NegotiationState, accept: boolean): Step {
  const i = state.incoming;
  if (!i) return { state };
  if (!accept) {
    return { state: { ...state, incoming: null }, send: { t: "suite", op: "decline", id: i.id } };
  }
  return {
    state: { ...state, active: i.suite, incoming: null },
    send: { t: "suite", op: "accept", suite: i.suite, id: i.id },
    activate: i.suite,
  };
}

/** Parses a suite message from untrusted decrypted text. Returns null if it is not valid. */
export function validSuiteMessage(raw: Record<string, unknown>): SuiteMessage | null {
  if (raw.t !== "suite") return null;
  if (typeof raw.id !== "string" || !/^[0-9a-f]{16}$/.test(raw.id)) return null;
  if (raw.op === "decline") return { t: "suite", op: "decline", id: raw.id };
  if ((raw.op === "propose" || raw.op === "accept") && isCipherSuite(raw.suite)) {
    return { t: "suite", op: raw.op, suite: raw.suite, id: raw.id };
  }
  return null;
}

/** A fresh 64-bit identifier for a proposal. */
export function newProposalId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
