import { describe, it, expect } from "vitest";
import {
  answerIncoming,
  initialNegotiation,
  proposeSuite,
  receiveSuiteMessage,
  validSuiteMessage,
  type NegotiationState,
} from "../../src/p2p/suiteNegotiation";
import { decodeControl, encodeControl } from "../../src/p2p/control";

const ID = "0123456789abcdef";

describe("suite negotiation", () => {
  it("refuses to propose the suite that is already active", () => {
    const step = proposeSuite(initialNegotiation(), "aes-256-gcm", ID);
    expect(step.rejected).toBe("same-suite");
    expect(step.send).toBeUndefined();
  });

  it("a change happens only after the other person accepts", () => {
    // Alice proposes ChaCha; Bob receives it.
    const a0 = initialNegotiation();
    const a1 = proposeSuite(a0, "chacha20-poly1305", ID);
    expect(a1.state.outgoing).toEqual({ id: ID, suite: "chacha20-poly1305" });
    expect(a1.activate).toBeUndefined(); // Alice has not switched yet

    const b0 = initialNegotiation();
    const b1 = receiveSuiteMessage(b0, a1.send!);
    expect(b1.state.incoming).toEqual({ id: ID, suite: "chacha20-poly1305" });
    expect(b1.state.active).toBe("aes-256-gcm"); // still waiting for Bob

    const b2 = answerIncoming(b1.state, true);
    expect(b2.activate).toBe("chacha20-poly1305");
    expect(b2.state.active).toBe("chacha20-poly1305");
    expect(b2.send).toEqual({ t: "suite", op: "accept", suite: "chacha20-poly1305", id: ID });

    // Alice gets the acceptance and switches too.
    const a2 = receiveSuiteMessage(a1.state, b2.send!);
    expect(a2.activate).toBe("chacha20-poly1305");
    expect(a2.state.active).toBe("chacha20-poly1305");
    expect(a2.state.outgoing).toBeNull();
  });

  it("a declined proposal changes nothing on either side", () => {
    const a1 = proposeSuite(initialNegotiation(), "chacha20-poly1305", ID);
    const b1 = receiveSuiteMessage(initialNegotiation(), a1.send!);
    const b2 = answerIncoming(b1.state, false);
    expect(b2.state.active).toBe("aes-256-gcm");
    expect(b2.activate).toBeUndefined();
    const a2 = receiveSuiteMessage(a1.state, b2.send!);
    expect(a2.state.outgoing).toBeNull();
    expect(a2.state.active).toBe("aes-256-gcm");
    expect(a2.activate).toBeUndefined();
  });

  it("an acceptance with the wrong id or suite is ignored", () => {
    const a1 = proposeSuite(initialNegotiation(), "chacha20-poly1305", ID);
    const forged = receiveSuiteMessage(a1.state, { t: "suite", op: "accept", suite: "chacha20-poly1305", id: "ffffffffffffffff" });
    expect(forged.activate).toBeUndefined();
    expect(forged.state.active).toBe("aes-256-gcm");
    const wrongSuite = receiveSuiteMessage(a1.state, { t: "suite", op: "accept", suite: "aes-256-gcm", id: ID });
    expect(wrongSuite.activate).toBeUndefined();
  });

  it("a replayed acceptance after the switch does nothing", () => {
    const a1 = proposeSuite(initialNegotiation(), "chacha20-poly1305", ID);
    const b2 = answerIncoming(receiveSuiteMessage(initialNegotiation(), a1.send!).state, true);
    const a2 = receiveSuiteMessage(a1.state, b2.send!);
    const replay = receiveSuiteMessage(a2.state, b2.send!);
    expect(replay.activate).toBeUndefined();
  });

  it("proposing the suite that is already active from the other side is a no-op", () => {
    const state: NegotiationState = { active: "chacha20-poly1305", outgoing: null, incoming: null };
    const step = receiveSuiteMessage(state, { t: "suite", op: "propose", suite: "chacha20-poly1305", id: ID });
    expect(step.state.incoming).toBeNull();
  });

  it("validates untrusted suite messages", () => {
    expect(validSuiteMessage({ t: "suite", op: "propose", suite: "chacha20-poly1305", id: ID })).not.toBeNull();
    expect(validSuiteMessage({ t: "suite", op: "decline", id: ID })).not.toBeNull();
    expect(validSuiteMessage({ t: "suite", op: "propose", suite: "none", id: ID })).toBeNull();
    expect(validSuiteMessage({ t: "suite", op: "propose", suite: "aes-256-gcm", id: "short" })).toBeNull();
    expect(validSuiteMessage({ t: "suite", op: "explode", id: ID })).toBeNull();
  });

  it("survives the control-message round trip inside the chat", () => {
    const msg = { t: "suite" as const, op: "propose" as const, suite: "chacha20-poly1305" as const, id: ID };
    expect(decodeControl(encodeControl(msg))).toEqual(msg);
    expect(decodeControl(encodeControl({ t: "wipe" }))).toEqual({ t: "wipe" });
  });
});
