import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CONTACT_LIMIT_MESSAGE,
  ContactLimitError,
  MAX_CONTACTS,
  canAddContact,
  countContacts,
  deleteContact,
  getContact,
  lockContacts,
  renameContact,
  saveContact,
  unlockContacts,
  type Contact,
} from "../../src/contacts/contacts";
import { EN_DICTIONARY } from "../../src/i18n/en";
import { RU_DICTIONARY } from "../../src/i18n/ru";
import { DE_DICTIONARY } from "../../src/i18n/de";
import { ES_DICTIONARY } from "../../src/i18n/es";
import { PT_DICTIONARY } from "../../src/i18n/pt";

const did = (i: number) => `did:key:z6MkLimit${String(i).padStart(40, "0")}`;
const contact = (i: number, name = `Контакт ${i}`): Contact => ({
  did: did(i),
  publicKey: new Uint8Array([i & 255, 1, 2, 3]),
  name,
  verified: true,
  verifiedAt: i,
  addedAt: i,
});

async function fill(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await saveContact(contact(i));
}

beforeEach(async () => {
  // @ts-expect-error - fresh in-memory factory per test
  globalThis.indexedDB = new IDBFactory();
  lockContacts();
  await unlockContacts(new Uint8Array(32).fill(5));
});

describe("the contact book holds at most 99 contacts", () => {
  it("is 99", () => {
    expect(MAX_CONTACTS).toBe(99);
  });

  it("refuses the 100th new contact and keeps the 99", async () => {
    await fill(MAX_CONTACTS);
    expect(await countContacts()).toBe(99);
    expect(await canAddContact()).toBe(false);
    await expect(saveContact(contact(500))).rejects.toBeInstanceOf(ContactLimitError);
    expect(await countContacts()).toBe(99);
    expect(await getContact(did(500))).toBeNull();
  });

  it("still lets a saved contact be updated or renamed when the book is full", async () => {
    await fill(MAX_CONTACTS);
    await saveContact({ ...contact(3), name: "Нова версия" });
    await renameContact(did(4), "Преименуван");
    expect((await getContact(did(3)))?.name).toBe("Нова версия");
    expect((await getContact(did(4)))?.name).toBe("Преименуван");
    expect(await countContacts()).toBe(99);
  });

  it("frees a place when a contact is deleted", async () => {
    await fill(MAX_CONTACTS);
    await deleteContact(did(0));
    expect(await canAddContact()).toBe(true);
    await saveContact(contact(500));
    expect(await countContacts()).toBe(99);
  });

  it("a move to a new device keeps the whole book, even one made before the limit", async () => {
    await fill(MAX_CONTACTS);
    await saveContact(contact(500), { allowOverLimit: true });
    expect(await countContacts()).toBe(100);
    await expect(saveContact(contact(501))).rejects.toBeInstanceOf(ContactLimitError);
  });

  it("the message is translated in every language", () => {
    for (const d of [EN_DICTIONARY, RU_DICTIONARY, DE_DICTIONARY, ES_DICTIONARY, PT_DICTIONARY]) {
      expect(d[CONTACT_LIMIT_MESSAGE]).toMatch(/99/);
    }
  });
});
