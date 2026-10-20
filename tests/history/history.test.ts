import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import {
  appendMessage,
  deleteHistory,
  deriveHistoryKey,
  loadHistory,
  validLocation,
} from "../../src/history/messageStore";
import type { UnlockedIdentity } from "../../src/identity/types";
import { publicKeyToDidKey } from "../../src/identity/didKey";

function identity(): UnlockedIdentity {
  const keyPair = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
  return { did: publicKeyToDidKey(keyPair.publicKey), keyPair };
}

beforeEach(() => {
  // @ts-expect-error - a fresh in-memory database for every test
  globalThis.indexedDB = new IDBFactory();
});

describe("location messages in history", () => {
  it("stores and reloads a location with its accuracy", async () => {
    const key = deriveHistoryKey(identity());
    await appendMessage(key, "did:a", { text: "", location: { lat: 42.5, lng: 23.3, accuracy: 9 }, direction: "out", timestamp: 1 });
    const [msg] = await loadHistory(key, "did:a");
    expect(msg.location).toEqual({ lat: 42.5, lng: 23.3, accuracy: 9 });
    expect(msg.text).toBe("");
  });

  it("validLocation rounds accuracy and rejects impossible values", () => {
    expect(validLocation({ lat: 1, lng: 2, accuracy: 3.6 })).toEqual({ lat: 1, lng: 2, accuracy: 4 });
    expect(validLocation({ lat: 100, lng: 2, accuracy: 3 })).toBeNull();
  });
});

describe("deleting a chat", () => {
  it("removes every message with that contact and nothing else", async () => {
    const key = deriveHistoryKey(identity());
    await appendMessage(key, "did:a", { text: "един", direction: "in", timestamp: 1 });
    await appendMessage(key, "did:a", { text: "", image: "data:image/png;base64,AAAA", direction: "out", timestamp: 2 });
    await appendMessage(key, "did:a", { text: "", location: { lat: 1, lng: 1, accuracy: 1 }, direction: "in", timestamp: 3 });
    await appendMessage(key, "did:b", { text: "друг контакт", direction: "in", timestamp: 4 });

    expect(await deleteHistory("did:a")).toBe(3);
    expect(await loadHistory(key, "did:a")).toEqual([]);
    expect(await loadHistory(key, "did:b")).toHaveLength(1);
  });

  it("is a no-op for a contact with no history", async () => {
    expect(await deleteHistory("did:nobody")).toBe(0);
  });
});
