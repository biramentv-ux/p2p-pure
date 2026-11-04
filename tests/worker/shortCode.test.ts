import { describe, it, expect } from "vitest";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  ROOM_ID_LENGTH,
  inviteKey,
  newInviteCode,
  newRoomId,
  normalizeInviteCode,
  normalizeRoomId,
} from "../../worker/logic";

describe("short invite codes", () => {
  it("uses an alphabet without look-alike characters", () => {
    for (const bad of ["0", "1", "O", "I", "L", "U"]) expect(INVITE_CODE_ALPHABET).not.toContain(bad);
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(30);
  });

  it("generates codes of the right length from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = newInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      for (const ch of code) expect(INVITE_CODE_ALPHABET).toContain(ch);
    }
  });

  it("skips bytes that would bias the distribution", () => {
    // 250 is above the unbiased limit (240) and must be skipped; the next batch supplies valid bytes.
    const batches = [new Uint8Array(INVITE_CODE_LENGTH).fill(250), new Uint8Array(INVITE_CODE_LENGTH).fill(0)];
    const code = newInviteCode(() => batches.shift() ?? new Uint8Array(INVITE_CODE_LENGTH).fill(0));
    expect(code).toBe(INVITE_CODE_ALPHABET[0].repeat(INVITE_CODE_LENGTH));
  });

  it("normalizes typed input", () => {
    expect(normalizeInviteCode("ab23 cd-efgh")).toBe("AB23CDEFGH");
    expect(normalizeInviteCode("AB23CDEFG")).toBeNull(); // too short
    expect(normalizeInviteCode("AB23CDEF0H")).toBeNull(); // 0 is not in the alphabet
    expect(normalizeInviteCode("")).toBeNull();
  });

  it("namespaces KV keys so they never collide with deliveries", () => {
    expect(inviteKey("ABCDEFGHJK")).toBe("i:ABCDEFGHJK");
  });
});

describe("demo room ids", () => {
  it("issues 5-character ids from the invite alphabet", () => {
    expect(ROOM_ID_LENGTH).toBe(5);
    for (let i = 0; i < 200; i++) {
      const id = newRoomId();
      expect(id).toHaveLength(5);
      for (const ch of id) expect(INVITE_CODE_ALPHABET).toContain(ch);
    }
  });

  it("skips biased bytes", () => {
    const batches = [new Uint8Array(5).fill(245), new Uint8Array(5).fill(29)];
    const id = newRoomId(() => batches.shift() ?? new Uint8Array(5));
    expect(id).toBe(INVITE_CODE_ALPHABET[29].repeat(5));
  });

  it("accepts the new 5-character id and the legacy 10-character id", () => {
    expect(normalizeRoomId("k7m2q")).toBe("K7M2Q");
    expect(normalizeRoomId(" K7M-2Q ")).toBe("K7M2Q");
    expect(normalizeRoomId("ab23 cd-efgh")).toBe("AB23CDEFGH");
  });

  it("rejects other lengths and look-alike characters", () => {
    expect(normalizeRoomId("")).toBeNull();
    expect(normalizeRoomId("K7M2")).toBeNull();
    expect(normalizeRoomId("K7M2QX")).toBeNull();
    expect(normalizeRoomId("K7M2O")).toBeNull();
    expect(normalizeRoomId("AB23CDEFG")).toBeNull();
    expect(normalizeRoomId("AB23CDEFGHJ")).toBeNull();
  });
});
