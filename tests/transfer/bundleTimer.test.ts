import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES, encodeBundle } from "../../src/transfer/bundle";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { MAX_CONTACTS, type Contact } from "../../src/contacts/contacts";
import { DAY } from "../../src/history/disappearing";

describe("transfer bundle with timers", () => {
  it("a full book (99 contacts, longest names, every timer on) still fits", () => {
    const contacts: Contact[] = [];
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const kp = deriveIdentityKeyPair(new Uint8Array(64).fill(i % 250).map((b, j) => (j === 0 ? i >> 8 : b)));
      contacts.push({
        did: publicKeyToDidKey(kp.publicKey),
        publicKey: kp.publicKey,
        name: "漢".repeat(200),
        verified: true,
        verifiedAt: 1_763_200_000_000,
        addedAt: 1_763_200_000_000,
        disappearMs: 7 * DAY,
        disappearAt: 1_763_200_000_000,
      });
    }
    const bytes = encodeBundle({ seed: new Uint8Array(64).fill(3), contacts });
    expect(bytes.length).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
  });
});
