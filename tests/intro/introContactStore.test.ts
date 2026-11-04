import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { STORE_CONTACTS_SEALED, withStore } from "../../src/db/database";
import {
  getContact,
  listContacts,
  lockContacts,
  markContactVerified,
  saveContact,
  unlockContacts,
} from "../../src/contacts/contacts";
import { person } from "../group/fakeLinks";

describe("introduced contacts in the encrypted contact book", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    lockContacts();
    await unlockContacts(new Uint8Array(32).fill(4));
  });

  it("introducedBy is saved, sealed at rest, and the contact stays unverified until the code is compared", async () => {
    const b = person("Боян");
    const c = person("Цвети");
    await saveContact({ ...b.contact, verified: false, introducedBy: { did: c.did, name: "Цвети" } });

    const saved = await getContact(b.did);
    expect(saved?.verified).toBe(false);
    expect(saved?.introducedBy).toEqual({ did: c.did, name: "Цвети" });
    expect((await listContacts())[0].introducedBy?.name).toBe("Цвети");

    const raw = JSON.stringify(await withStore<unknown[]>(STORE_CONTACTS_SEALED, "readonly", (s) => s.getAll()));
    expect(raw).not.toContain("Цвети");
    expect(raw).not.toContain(c.did);

    await markContactVerified(b.did);
    const after = await getContact(b.did);
    expect(after?.verified).toBe(true);
    expect(after?.verifiedAt).toBeTypeOf("number");
    expect(after?.introducedBy?.did).toBe(c.did);
  });

  it("a contact without an introduction has no introducedBy field", async () => {
    const a = person("Ана");
    await saveContact(a.contact);
    expect((await getContact(a.did))?.introducedBy).toBeUndefined();
  });
});
