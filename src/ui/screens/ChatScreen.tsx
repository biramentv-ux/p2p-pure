import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Contact } from "../../contacts/contacts";
import { appendMessage, loadHistory, type ChatMessage } from "../../history/messageStore";
import type { PeerLink } from "../../p2p/peer";
import { isEncryptedMessage, type SecureSession } from "../../p2p/secureSession";
import { buildPhotoFrames, PhotoReceiver, sanitizeText, sniffMime } from "../../p2p/photo";
import { prepareImage } from "../image";

interface ChatScreenProps {
  contact: Contact;
  link: PeerLink;
  session: SecureSession;
  historyKey: Uint8Array;
  onClose: () => void;
}

export function ChatScreen({ contact, link, session, historyKey, onClose }: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(link.isOpen());
  const [transfer, setTransfer] = useState<{ label: string; done: number; total: number } | null>(null);
  const receiverRef = useRef(new PhotoReceiver());
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);

  // Sends and receives are chained so counters and chain keys advance in order.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(task, task);
    queueRef.current = next.catch(() => undefined);
    return next;
  };

  useEffect(() => {
    let alive = true;
    loadHistory(historyKey, contact.did)
      .then((history) => {
        if (alive) setMessages(history);
      })
      .catch(() => alive && setNotice("Историята не можа да се прочете."));

    const off = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void enqueue(async () => {
        try {
          const plaintext = await session.open(text);
          const result = receiverRef.current.feed(plaintext);
          if (result.kind === "progress") {
            if (alive) setTransfer({ label: "Получавам снимка", done: result.received, total: result.total });
            return;
          }
          if (result.kind === "rejected") {
            if (alive) {
              setTransfer(null);
              setNotice(result.reason);
            }
            return;
          }
          const msg: ChatMessage =
            result.kind === "photo"
              ? { text: "", image: result.dataUrl, direction: "in", timestamp: Date.now() }
              : { text: result.text, direction: "in", timestamp: Date.now() };
          await appendMessage(historyKey, contact.did, msg);
          if (alive) {
            setTransfer(null);
            setMessages((prev) => [...prev, msg]);
          }
        } catch (err) {
          if (alive) setNotice(err instanceof Error ? err.message : "Съобщението не можа да се разшифрова.");
        }
      });
    });

    const timer = setInterval(() => alive && setConnected(link.isOpen()), 1000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
    // Mount-only: the link and session are owned by the parent for this chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSend(e: FormEvent) {
    e.preventDefault();
    const text = sanitizeText(draft).trim();
    if (!text) return;
    setDraft("");
    void enqueue(async () => {
      try {
        const wire = await session.seal(text);
        link.send(wire);
        const msg: ChatMessage = { text, direction: "out", timestamp: Date.now() };
        await appendMessage(historyKey, contact.did, msg);
        setMessages((prev) => [...prev, msg]);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Съобщението не беше изпратено.");
      }
    });
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    try {
      const bytes = await prepareImage(file);
      const mime = sniffMime(bytes);
      if (!mime) throw new Error("Снимката не може да се обработи.");
      const frames = buildPhotoFrames(bytes, mime);
      await enqueue(async () => {
        try {
          for (let i = 0; i < frames.length; i++) {
            link.send(await session.seal(frames[i]));
            setTransfer({ label: "Изпращам снимка", done: i, total: frames.length });
            await link.waitForDrain();
          }
          const url = `data:${mime};base64,${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))}`;
          const msg: ChatMessage = { text: "", image: url, direction: "out", timestamp: Date.now() };
          await appendMessage(historyKey, contact.did, msg);
          setMessages((prev) => [...prev, msg]);
        } finally {
          setTransfer(null);
        }
      });
    } catch (err) {
      setTransfer(null);
      setNotice(err instanceof Error ? err.message : "Снимката не беше изпратена.");
    }
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="secondary" onClick={onClose}>
          Назад
        </button>
        <div>
          <strong>{contact.name}</strong>
          <span className={connected ? "status on" : "status off"}>
            {connected ? " · свързан" : " · връзката е прекъсната"}
          </span>
        </div>
      </header>

      {notice && <p role="alert" className="chat-notice">{notice}</p>}

      <ol className="messages">
        {messages.map((m, i) => (
          <li key={`${m.timestamp}-${i}`} className={m.direction === "out" ? "msg out" : "msg in"}>
            {m.image ? (
              <img className="msg-image" src={m.image} alt="Снимка" />
            ) : (
              <span className="msg-text">{m.text}</span>
            )}
            <time>{new Date(m.timestamp).toLocaleTimeString("bg-BG", { hour: "2-digit", minute: "2-digit" })}</time>
          </li>
        ))}
        {messages.length === 0 && <li className="empty">Няма съобщения още. Кажи здравей.</li>}
      </ol>

      {transfer && (
        <p className="chat-notice" role="status">
          {transfer.label}: {Math.min(100, Math.round((transfer.done / transfer.total) * 100))}%
        </p>
      )}

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void onPickPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void onPickPhoto(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <form className="composer" onSubmit={onSend}>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!transfer}
          onClick={() => cameraInput.current?.click()}
          aria-label="Снимай с камерата"
        >
          Камера
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!transfer}
          onClick={() => galleryInput.current?.click()}
          aria-label="Избери снимка от галерията"
        >
          Галерия
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Съобщение"
          maxLength={4000}
          aria-label="Съобщение"
          disabled={!connected}
        />
        <button type="submit" disabled={!connected || !draft.trim()}>
          Изпрати
        </button>
      </form>
    </div>
  );
}
