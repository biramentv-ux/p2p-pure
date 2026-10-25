import { describe, it, expect } from "vitest";
import {
  acceptSnapshot,
  addMember,
  applySuiteVote,
  approveSuite,
  createGroup,
  GroupError,
  MAX_GROUP_MEMBERS,
  normalizeGroupName,
  proposeSuite,
  removeMember,
  renameGroup,
  setPhotoHash,
  suiteVoteComplete,
  type GroupState,
} from "../../src/group/groupModel";

const ADMIN = "did:key:admin";
const creator = { did: ADMIN, name: "Ани" };
const member = (i: number) => ({ did: `did:key:m${i}`, name: `М${i}` });

function full(): GroupState {
  let s = createGroup({ groupId: "g1", name: "Група", creator });
  for (let i = 1; i < MAX_GROUP_MEMBERS; i++) s = addMember(s, ADMIN, member(i));
  return s;
}

describe("group model", () => {
  it("starts with the creator as the only member and admin", () => {
    const s = createGroup({ groupId: "g1", name: "  Семейство  ", creator });
    expect(s.name).toBe("Семейство");
    expect(s.members).toEqual([creator]);
    expect(s.creatorDid).toBe(ADMIN);
    expect(s.version).toBe(1);
    expect(s.epoch).toBe(0);
  });

  it("allows at most 9 members, creator included", () => {
    const s = full();
    expect(s.members).toHaveLength(9);
    expect(() => addMember(s, ADMIN, member(99))).toThrow(GroupError);
    try {
      addMember(s, ADMIN, member(99));
    } catch (e) {
      expect((e as GroupError).code).toBe("full");
    }
  });

  it("only the creator adds, removes, renames or changes the photo", () => {
    const s = addMember(createGroup({ groupId: "g1", name: "A", creator }), ADMIN, member(1));
    const code = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as GroupError).code;
      }
    };
    expect(code(() => addMember(s, "did:key:m1", member(2)))).toBe("not-admin");
    expect(code(() => removeMember(s, "did:key:m1", ADMIN))).toBe("not-admin");
    expect(code(() => renameGroup(s, "did:key:m1", "Нова"))).toBe("not-admin");
    expect(code(() => setPhotoHash(s, "did:key:m1", "a".repeat(64)))).toBe("not-admin");
  });

  it("refuses duplicates and unknown or creator removals", () => {
    const s = addMember(createGroup({ groupId: "g1", name: "A", creator }), ADMIN, member(1));
    expect(() => addMember(s, ADMIN, member(1))).toThrow(expect.objectContaining({ code: "duplicate" }));
    expect(() => removeMember(s, ADMIN, ADMIN)).toThrow(expect.objectContaining({ code: "cannot-remove-admin" }));
    expect(() => removeMember(s, ADMIN, "did:key:nobody")).toThrow(expect.objectContaining({ code: "unknown-member" }));
  });

  it("adding and removing members bump the epoch and the version", () => {
    const s0 = createGroup({ groupId: "g1", name: "A", creator });
    const s1 = addMember(s0, ADMIN, member(1));
    expect(s1.epoch).toBe(1);
    expect(s1.version).toBe(2);
    const s2 = removeMember(s1, ADMIN, member(1).did);
    expect(s2.epoch).toBe(2);
    expect(s2.members).toEqual([creator]);
  });

  it("validates the name: 1 to 40 characters", () => {
    expect(() => normalizeGroupName("   ")).toThrow(expect.objectContaining({ code: "bad-name" }));
    expect(() => normalizeGroupName("а".repeat(41))).toThrow(expect.objectContaining({ code: "bad-name" }));
    expect(normalizeGroupName("а".repeat(40))).toHaveLength(40);
  });

  it("accepts only a well-formed photo hash or no photo", () => {
    const s = createGroup({ groupId: "g1", name: "A", creator });
    expect(setPhotoHash(s, ADMIN, "ab".repeat(32)).photoHash).toBe("ab".repeat(32));
    expect(setPhotoHash(s, ADMIN, null).photoHash).toBeNull();
    expect(() => setPhotoHash(s, ADMIN, "not-a-hash")).toThrow(expect.objectContaining({ code: "bad-hash" }));
  });

  it("a cipher-suite change needs every member to approve", () => {
    let s = addMember(createGroup({ groupId: "g1", name: "A", creator }), ADMIN, member(1));
    s = addMember(s, ADMIN, member(2));
    let vote = proposeSuite(s, ADMIN, "chacha20-poly1305", "0123456789abcdef");
    expect(suiteVoteComplete(s, vote)).toBe(false);
    expect(() => applySuiteVote(s, vote)).toThrow(expect.objectContaining({ code: "vote-open" }));
    vote = approveSuite(s, vote, member(1).did);
    expect(suiteVoteComplete(s, vote)).toBe(false);
    vote = approveSuite(s, vote, member(2).did);
    expect(suiteVoteComplete(s, vote)).toBe(true);
    const done = applySuiteVote(s, vote);
    expect(done.suite).toBe("chacha20-poly1305");
    expect(done.version).toBe(s.version + 1);
  });

  it("refuses to propose the active suite or to let a non-member approve", () => {
    const s = createGroup({ groupId: "g1", name: "A", creator });
    expect(() => proposeSuite(s, ADMIN, "aes-256-gcm", "0123456789abcdef")).toThrow(
      expect.objectContaining({ code: "same-suite" }),
    );
    const vote = proposeSuite(s, ADMIN, "chacha20-poly1305", "0123456789abcdef");
    expect(() => approveSuite(s, vote, "did:key:stranger")).toThrow(expect.objectContaining({ code: "not-member" }));
  });

  it("an older snapshot cannot replace a newer one", () => {
    const old = createGroup({ groupId: "g1", name: "A", creator });
    const newer = addMember(old, ADMIN, member(1));
    expect(acceptSnapshot(old, newer)).toBe(newer);
    expect(() => acceptSnapshot(newer, old)).toThrow(expect.objectContaining({ code: "stale" }));
    expect(() => acceptSnapshot(newer, { ...newer, groupId: "other" })).toThrow(expect.objectContaining({ code: "stale" }));
  });
});
