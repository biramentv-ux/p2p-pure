import { useEffect, useRef, useState } from "react";
import type { Contact } from "../contacts/contacts";
import type { ChatMessage, FileCard } from "../history/messageStore";
import { canStore, saveFile } from "../history/fileStore";
import { FileTransferError, FileTransfers, MAX_FILE_BYTES, PAUSED_REASON, parkedFiles, type FileMeta } from "../p2p/fileTransfer";
import type { PeerLink } from "../p2p/peer";
import type { SecureSession } from "../p2p/secureSession";
import type { ActiveTransfer } from "./components/FileBubble";

export interface ChatFilesOptions {
  link: PeerLink;
  session: SecureSession;
  /** The chat's single send/receive queue (ratchet order). */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  historyKey: Uint8Array;
  contact: Contact;
  /** Writes a history entry and shows it (the chat adds its timer). */
  addMessage: (msg: ChatMessage) => Promise<void>;
  /** A line for the person (Bulgarian source text, translated by the caller). */
  notice: (text: string) => void;
  /** Sound and notification for an incoming file offer. */
  incoming: (fileName: string) => void;
}

/**
 * Files in a 1:1 chat (Н5): the transfers on this link, the list in progress, kept files and
 * the object URLs made in this session. Transfers a dropped link left half-way continue on
 * the next link with this contact (parkedFiles). The chat still routes decrypted file frames
 * here with `filesRef.current.handleControl()`.
 */
export function useChatFiles(options: ChatFilesOptions) {
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });
  const { link, session, contact } = options;
  const filesRef = useRef<FileTransfers | null>(null);
  const [active, setActive] = useState<ActiveTransfer[]>([]);
  const [preparing, setPreparing] = useState<string | null>(null);
  const urlsRef = useRef(new Map<string, string>());

  const upsert = (item: ActiveTransfer) => setActive((prev) => [...prev.filter((a) => a.id !== item.id), item]);
  const drop = (id: string) => setActive((prev) => prev.filter((a) => a.id !== id));

  /** Keeps a file (up to 25 MB) encrypted on the device and returns its card for the history. */
  async function keepFile(meta: FileMeta, blob: Blob): Promise<FileCard> {
    urlsRef.current.set(meta.id, URL.createObjectURL(blob));
    let stored = canStore(meta.size);
    if (stored) {
      try {
        await saveFile(opts.current.historyKey, contact.did, meta.id, blob);
      } catch {
        stored = false;
      }
    }
    return { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, stored };
  }

  useEffect(() => {
    let alive = true;
    const { enqueue } = opts.current;
    const files = new FileTransfers(
      {
        sendControl: (plaintext) =>
          enqueue(async () => {
            link.send(await session.seal(plaintext));
          }),
        sendBinary: (bytes) => link.sendBinary(bytes),
      },
      {
        offered: (m) => {
          if (!alive) return;
          upsert({ id: m.id, name: m.name, size: m.size, direction: "in", phase: "offer", done: 0 });
          opts.current.incoming(m.name);
        },
        outgoing: (m) => {
          if (!alive) return;
          setPreparing(null);
          upsert({ id: m.id, name: m.name, size: m.size, direction: "out", phase: "waiting", done: 0 });
        },
        progress: (id, done) => alive && setActive((prev) => prev.map((a) => (a.id === id ? { ...a, phase: "moving", done } : a))),
        paused: (m, done, direction) => alive && upsert({ id: m.id, name: m.name, size: m.size, direction, phase: "paused", done }),
        resumed: (m, done, direction) =>
          alive && upsert({ id: m.id, name: m.name, size: m.size, direction, phase: direction === "in" ? "moving" : "waiting", done }),
        received: (meta, blob) => {
          void (async () => {
            const card = await keepFile(meta, blob);
            await opts.current.addMessage({ text: "", file: card, direction: "in", timestamp: Date.now() });
            if (alive) drop(meta.id);
          })();
        },
        // Also for a file that resumed on this link after an earlier link dropped.
        sent: (meta, blob) => {
          void (async () => {
            const card = await keepFile(meta, new Blob([blob], { type: meta.mime }));
            await opts.current.addMessage({ text: "", file: card, direction: "out", timestamp: Date.now() });
            if (alive) drop(meta.id);
          })();
        },
        failed: (id, reason) => {
          if (!alive) return;
          drop(id);
          if (reason !== "Отказано.") opts.current.notice(reason);
        },
      },
      MAX_FILE_BYTES,
      { store: parkedFiles, peer: contact.did },
    );
    filesRef.current = files;
    // Files the last link with this contact left half-way continue here.
    void files.resume();
    // A dropped link parks transfers in progress at once, so the list says "paused".
    const offClose = link.onClose(() => files.close());
    const offBinary = link.onBinary((bytes) => files.handleBinary(bytes));
    const urls = urlsRef.current;
    return () => {
      alive = false;
      offClose();
      offBinary();
      files.close();
      filesRef.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
    // Mount-only: the link and session are owned by the parent for this chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends any file up to 100 MB. The other side sees a card and decides whether to take it. */
  async function sendFile(file: File): Promise<void> {
    const files = filesRef.current;
    if (!files) return;
    if (file.size > MAX_FILE_BYTES) throw new FileTransferError(`Файлът е по-голям от ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`);
    setPreparing(file.name);
    try {
      // The offer is out once the file is hashed; the "sent" event writes the history entry.
      await files.send(file, file.name).finally(() => setPreparing(null));
    } catch (err) {
      if (err instanceof FileTransferError && err.paused) {
        opts.current.notice(PAUSED_REASON);
        return;
      }
      throw err;
    }
  }

  return {
    filesRef,
    active,
    preparing,
    /** The object URL of a file sent or received in this session. */
    urlFor: (id: string) => urlsRef.current.get(id),
    sendFile,
    accept: (id: string) => void filesRef.current?.accept(id),
    /** Stops one transfer, also a paused one waiting for the next link. */
    cancel: (id: string) => {
      drop(id);
      parkedFiles.dropTransfer(contact.did, id);
      void filesRef.current?.cancel(id);
    },
    /** The chat was wiped: stop everything and forget paused files. */
    forgetAll: () => {
      for (const a of active) void filesRef.current?.cancel(a.id);
      parkedFiles.drop(contact.did);
      setActive([]);
    },
    /** Releases the decrypted copies of files whose messages expired. */
    release: (ids: string[]) => {
      for (const id of ids) {
        const url = urlsRef.current.get(id);
        if (url) URL.revokeObjectURL(url);
        urlsRef.current.delete(id);
      }
    },
  };
}
