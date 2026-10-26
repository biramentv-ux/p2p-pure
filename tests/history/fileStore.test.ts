import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { canStore, deleteFilesFor, loadFile, saveFile } from "../../src/history/fileStore";
import { appendMessage, loadHistory, validFileCard, type ChatMessage } from "../../src/history/messageStore";
import { STORE_FILES, withStore } from "../../src/db/database";
import { MAX_STORED_FILE_BYTES } from "../../src/p2p/fileTransfer";

const KEY = crypto.getRandomValues(new Uint8Array(32));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

async function bytesOf(blob: Blob | null): Promise<number[] | null> {
  return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null;
}

describe("file store", () => {
  it("keeps a file encrypted and gives it back to its own chat only", async () => {
    const data = new Uint8Array([1, 2, 3, 250]);
    await saveFile(KEY, "did:a", "AAAAAAAAAAA", new Blob([data], { type: "image/png" }));
    const back = await loadFile(KEY, "did:a", "AAAAAAAAAAA");
    expect(await bytesOf(back)).toEqual([1, 2, 3, 250]);
    expect(back?.type).toBe("image/png");
    expect(await loadFile(KEY, "did:b", "AAAAAAAAAAA")).toBeNull();
    expect(await loadFile(crypto.getRandomValues(new Uint8Array(32)), "did:a", "AAAAAAAAAAA")).toBeNull();
  });

  it("never writes the plaintext to the database", async () => {
    const secret = new TextEncoder().encode("тайно съдържание на файла");
    await saveFile(KEY, "did:a", "BBBBBBBBBBB", new Blob([secret]));
    const row = await withStore<{ ct: Uint8Array }>(STORE_FILES, "readonly", (s) => s.get("BBBBBBBBBBB"));
    expect(new TextDecoder().decode(row!.ct)).not.toContain("тайно");
  });

  it("refuses files over 25 MB and keeps the limit in one place", async () => {
    expect(canStore(MAX_STORED_FILE_BYTES)).toBe(true);
    expect(canStore(MAX_STORED_FILE_BYTES + 1)).toBe(false);
    expect(canStore(0)).toBe(false);
  });

  it("deleting a chat's files leaves other chats alone", async () => {
    await saveFile(KEY, "did:a", "CCCCCCCCCCC", new Blob([new Uint8Array([1])]));
    await saveFile(KEY, "did:b", "DDDDDDDDDDD", new Blob([new Uint8Array([2])]));
    await deleteFilesFor("did:a");
    expect(await loadFile(KEY, "did:a", "CCCCCCCCCCC")).toBeNull();
    expect(await bytesOf(await loadFile(KEY, "did:b", "DDDDDDDDDDD"))).toEqual([2]);
  });

  it("file cards round-trip through the encrypted history; bad cards are dropped", async () => {
    const card = { id: "EEEEEEEEEEE", name: "отчет.pdf", size: 1234, mime: "application/octet-stream", stored: true };
    const msg: ChatMessage = { text: "", file: card, direction: "in", timestamp: 1000 };
    await appendMessage(KEY, "did:a", msg);
    const [back] = await loadHistory(KEY, "did:a");
    expect(back.file).toEqual(card);
    expect(validFileCard({ ...card, id: "../x" })).toBeNull();
    expect(validFileCard({ ...card, size: -1 })).toBeNull();
  });
});
