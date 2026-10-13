import { describe, it, expect } from "vitest";
import {
  decodeChatCode,
  encodeChatCode,
  isAuthorizedWebhook,
  isValidInvitation,
  MAX_INVITATION_CHARS,
  parseCommand,
} from "../../worker/logic";

const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("chat codes", () => {
  it("round-trips positive and negative chat ids", () => {
    for (const id of [1, 42, 123456789, 7000000000, -1001234567890]) {
      expect(decodeChatCode(encodeChatCode(id))).toBe(id);
    }
  });

  it("rejects garbage, empty, zero and non-numeric codes", () => {
    expect(decodeChatCode("")).toBeNull();
    expect(decodeChatCode("!!!")).toBeNull();
    expect(decodeChatCode(encodeChatCode(0))).toBeNull();
    expect(decodeChatCode(Buffer.from("hello").toString("base64url"))).toBeNull();
  });

  it("rejects codes that decode to unsafe integers", () => {
    const huge = Buffer.from("9".repeat(19)).toString("base64url");
    expect(decodeChatCode(huge)).toBeNull();
  });
});

describe("invitation validation", () => {
  it("accepts a well-formed p2p1 payload", () => {
    expect(isValidInvitation(INVITE)).toBe(true);
  });

  it("rejects wrong prefix, spaces, and oversize payloads", () => {
    expect(isValidInvitation("p2p2:AAAA")).toBe(false);
    expect(isValidInvitation("p2p1:AA AA")).toBe(false);
    expect(isValidInvitation("p2p1:")).toBe(false);
    expect(isValidInvitation("p2p1:" + "A".repeat(MAX_INVITATION_CHARS))).toBe(false);
  });
});

describe("parseCommand", () => {
  const code = encodeChatCode(555);

  it("handles /start", () => {
    expect(parseCommand("/start")).toEqual({ kind: "start" });
    expect(parseCommand("/start ref123")).toEqual({ kind: "start" });
  });

  it("forwards a valid /send", () => {
    expect(parseCommand(`/send ${code}\n${INVITE}`)).toEqual({
      kind: "send",
      targetChatId: 555,
      invitation: INVITE,
    });
  });

  it("returns an error when the invitation is on the same line", () => {
    expect(parseCommand(`/send ${code} ${INVITE}`).kind).toBe("error");
  });

  it("returns an error for an invalid recipient code", () => {
    expect(parseCommand(`/send bad\n${INVITE}`)).toEqual({
      kind: "error",
      reason: "Невалиден код на получателя.",
    });
  });

  it("returns an error for an invalid invitation", () => {
    expect(parseCommand(`/send ${code}\nhello`).kind).toBe("error");
  });

  it("ignores unrelated text", () => {
    expect(parseCommand("здрасти")).toEqual({ kind: "ignore" });
    expect(parseCommand("")).toEqual({ kind: "ignore" });
  });
});

describe("webhook authorization", () => {
  it("accepts only the exact secret", () => {
    expect(isAuthorizedWebhook("s3cret-value", "s3cret-value")).toBe(true);
    expect(isAuthorizedWebhook("s3cret-valuE", "s3cret-value")).toBe(false);
    expect(isAuthorizedWebhook("short", "s3cret-value")).toBe(false);
  });

  it("rejects a missing header or an empty expected secret", () => {
    expect(isAuthorizedWebhook(null, "s3cret-value")).toBe(false);
    expect(isAuthorizedWebhook("", "")).toBe(false);
  });
});
