import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { IDBFactory } from "fake-indexeddb";
import { getContact, keepVouchFrom, linkKeyChange, lockContacts, saveContact, unlockContacts } from "../../src/contacts/contacts";
import { decodeControl, encodeControl } from "../../src/p2p/control";
import { judgeVouches, MAX_VOUCHES, parseVouch, signVouch, vouchSignatureOk, type Witness } from "../../src/trust/vouch";
import { person } from "../group/fakeLinks";

const me = (p: ReturnType<typeof person>) => ({ did: p.did, keyPair: p.keys });

describe("П7 signed statements", () => {
  const ana = person("Ани"); // the person who lost the words
  const anaNew = person("Ани (нова)");
  const iva = person("Ива"); // a witness who met Ani again
  const petar = person("Петър"); // the one who asks
  const stranger = person("Непознат");

  it("a statement verifies, and any change breaks it", () => {
    const v = signVouch(me(iva), ana.did, anaNew.did, 1_800_000_000_000);
    expect(vouchSignatureOk(v, 1_800_000_000_000)).toBe(true);
    expect(vouchSignatureOk({ ...v, old: stranger.did }, 1_800_000_000_000)).toBe(false);
    expect(vouchSignatureOk({ ...v, at: v.at + 1 }, 1_800_000_000_000)).toBe(false);
    expect(vouchSignatureOk({ ...v, by: petar.did }, 1_800_000_000_000)).toBe(false);
    // From far in the future: refused.
    expect(vouchSignatureOk(v, 1_700_000_000_000)).toBe(false);
  });

  it("nobody can vouch for themselves or for the same key", () => {
    expect(() => signVouch(me(iva), iva.did, anaNew.did)).toThrow();
    expect(() => signVouch(me(iva), ana.did, ana.did)).toThrow();
  });

  it("counts only my own verified contacts, once each", () => {
    const now = Date.now();
    const book = new Map<string, Witness>([
      [iva.did, { did: iva.did, name: "Ива", verified: true }],
      [petar.did, { did: petar.did, name: "Петър", verified: false }],
    ]);
    const lookup = (d: string) => book.get(d) ?? null;
    const statements = [
      signVouch(me(iva), ana.did, anaNew.did, now),
      signVouch(me(iva), ana.did, anaNew.did, now - 1), // the same witness twice
      signVouch(me(petar), ana.did, anaNew.did, now), // not verified by me
      signVouch(me(stranger), ana.did, anaNew.did, now), // unknown to me
      signVouch(me(iva), ana.did, stranger.did, now), // about another key
    ];
    const v = judgeVouches(statements, ana.did, anaNew.did, lookup, now);
    expect(v.confirmedBy.map((w) => w.name)).toEqual(["Ива"]);
    expect(v.ignored).toBe(3); // the duplicate from Iva is merged, not ignored
  });

  it("travels in the control channel and is parsed strictly", () => {
    const v = signVouch(me(iva), ana.did, anaNew.did);
    expect(decodeControl(encodeControl({ t: "vouch-grant", v }))).toEqual({ t: "vouch-grant", v });
    expect(decodeControl(encodeControl({ t: "vouch-ask", old: ana.did }))).toEqual({ t: "vouch-ask", old: ana.did });
    expect(decodeControl(encodeControl({ t: "vouch-list", old: ana.did, vs: [v] }))).toEqual({ t: "vouch-list", old: ana.did, vs: [v] });
    expect(parseVouch({ ...v, extra: 1 })).toBeNull();
    expect(parseVouch({ ...v, by: "did:key:zNope" })).toBeNull();
    const many = Array.from({ length: MAX_VOUCHES + 1 }, () => v);
    expect(decodeControl(`\u0001K|${JSON.stringify({ t: "vouch-list", old: ana.did, vs: many })}`)).toBeNull();
  });

  it("any input to the parser is a statement or null", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        const v = parseVouch(x);
        expect(v === null || typeof v.sig === "string").toBe(true);
      }),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 300) },
    );
  });
});

describe("П7 in the encrypted contact book", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    lockContacts();
    await unlockContacts(new Uint8Array(32).fill(5));
  });

  it("links the old and the new contact both ways and keeps statements given to me", async () => {
    const old = person("Ани");
    const neu = person("Ани 2");
    const iva = person("Ива");
    await saveContact(old.contact);
    await saveContact(neu.contact);
    await saveContact(iva.contact);
    await linkKeyChange(old.did, neu.did, ["Ива"], 123);
    expect((await getContact(neu.did))?.succeeds).toEqual({ did: old.did, name: "Ани", at: 123, by: ["Ива"] });
    expect((await getContact(old.did))?.replacedBy).toEqual({ did: neu.did, name: "Ани 2", at: 123, by: ["Ива"] });

    const v = signVouch(me(iva), old.did, neu.did);
    await keepVouchFrom(iva.did, v);
    await keepVouchFrom(iva.did, v); // the same old key again: replaced, not doubled
    expect((await getContact(iva.did))?.vouchesForMe).toEqual([v]);
  });
});
