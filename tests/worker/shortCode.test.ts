import { describe, it, expect } from "vitest";
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  inviteKey,
  newInviteCode,
  normalizeInviteCode,
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
