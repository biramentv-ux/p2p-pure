import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Contact } from "../../contacts/contacts";
import {
  appendMessage,
  deleteHistory,
  loadHistory,
  validLocation,
  type ChatMessage,
} from "../../history/messageStore";
import { decodeControl, encodeControl, isControlMessage } from "../../p2p/control";
import type { PeerLink } from "../../p2p/peer";
import { isEncryptedMessage, type SecureSession } from "../../p2p/secureSession";
import { buildPhotoFrames, PhotoReceiver, sanitizeText, sniffMime } from "../../p2p/photo";
import { prepareImage } from "../image";
import { CallController, type CallSnapshot } from "../../call/callController";
import { encodeSignal, isCallSignal, SignalAssembler } from "../../call/signal";
import { acquireMedia } from "../../call/media";
import { CallPanel } from "../components/CallPanel";

/** Longer than the browser's own 20 s timeout, so it only fires when the browser says nothing. */
const LOCATION_GUARD_MS = 25_000;

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
  const [call, setCall] = useState<CallSnapshot | null>(null);
  const callRef = useRef<CallController | null>(null);
  const assemblerRef = useRef(new SignalAssembler());
  const [locating, setLocating] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
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
    // Queued like every other operation: a wipe that arrives while the history is still
    // decrypting must run after the load, or the old list would come back on screen.
    void enqueue(async () => {
      try {
        const history = await loadHistory(historyKey, contact.did);
        if (alive) setMessages(history);
      } catch {
        if (alive) setNotice("Историята не можа да се прочете.");
      }
    });

    const controller = new CallController({
      pc: link.pc,
      acquire: acquireMedia,
      send: (signal) =>
        enqueue(async () => {
          for (const part of encodeSignal(signal)) link.send(await session.seal(part));
        }),
      onChange: (snap) => alive && setCall(snap),
    });
    callRef.current = controller;
    setCall(controller.state);

    const off = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void enqueue(async () => {
        try {
          const plaintext = await session.open(text);
          if (isCallSignal(plaintext)) {
            const signal = assemblerRef.current.feed(plaintext);
            // Not awaited: the controller may send a reply, which needs this queue to be free.
            if (signal) void callRef.current?.handle(signal);
            return;
          }
          if (isControlMessage(plaintext)) {
            const control = decodeControl(plaintext);
            if (!control) return;
            if (control.t === "wipe") {
              receiverRef.current.discardInProgress();
              await deleteHistory(contact.did);
              if (alive) {
                setTransfer(null);
                setMessages([]);
                setNotice("Другият човек изтри чата. Историята е изтрита и тук.");
              }
              return;
            }
            const located: ChatMessage = { text: "", location: control.fix, direction: "in", timestamp: Date.now() };
            await appendMessage(historyKey, contact.did, located);
            if (alive) setMessages((prev) => [...prev, located]);
            return;
          }
          const result = receiverRef.current.feed(plaintext);
          if (result.kind === "discarded") return;
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
      const c = callRef.current;
      callRef.current = null;
      if (c) void c.hangup().finally(() => c.dispose());
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

  /** Asks the device for a precise fix once, then sends it. Nothing is sent without a tap. */
  function onShareLocation() {
    setNotice(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNotice("Устройството не поддържа локация.");
      return;
    }
    setLocating(true);
    // Some browsers never answer an unanswered permission prompt. Do not leave the button stuck.
    let answered = false;
    const guard = setTimeout(() => {
      if (answered) return;
      answered = true;
      setLocating(false);
      setNotice("Не успях да определя локацията навреме. Провери разрешението за локация.");
    }, LOCATION_GUARD_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (answered) return;
        answered = true;
        clearTimeout(guard);
        setLocating(false);
        const fix = validLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        if (!fix) {
          setNotice("Не успях да определя локацията.");
          return;
        }
        void enqueue(async () => {
          try {
            link.send(await session.seal(encodeControl({ t: "loc", fix })));
            const msg: ChatMessage = { text: "", location: fix, direction: "out", timestamp: Date.now() };
            await appendMessage(historyKey, contact.did, msg);
            setMessages((prev) => [...prev, msg]);
          } catch (err) {
            setNotice(err instanceof Error ? err.message : "Локацията не беше изпратена.");
          }
        });
      },
      (err) => {
        if (answered) return;
        answered = true;
        clearTimeout(guard);
        setLocating(false);
        const code = (err as GeolocationPositionError).code;
        setNotice(
          code === 1
            ? "Нямаш разрешение за локацията."
            : code === 3
              ? "Определянето на локацията отне твърде дълго."
              : "Не успях да определя локацията.",
        );
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  /** Deletes the chat here and asks the other side to delete it too. */
  function onWipeChat() {
    setConfirmWipe(false);
    void enqueue(async () => {
      let delivered = true;
      try {
        link.send(await session.seal(encodeControl({ t: "wipe" })));
      } catch {
        delivered = false;
      }
      receiverRef.current.discardInProgress();
      await deleteHistory(contact.did);
      setMessages([]);
      setTransfer(null);
      setNotice(
        delivered
          ? "Чатът е изтрит и за двамата."
          : "Чатът е изтрит тук. Другият човек не беше на линия, затова няма да се изтрие при него.",
      );
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
        <div className="call-buttons">
          <button
            className="secondary"
            disabled={!connected}
            onClick={() => setConfirmWipe(true)}
            aria-label="Изтрий чата за двамата"
          >
            Изтрий чата
          </button>
          <button
            className="secondary"
            disabled={!connected || !call || (call.phase !== "idle" && call.phase !== "ended")}
            onClick={() => void callRef.current?.startCall("audio")}
            aria-label="Аудио разговор"
          >
            Аудио
          </button>
          <button
            className="secondary"
            disabled={!connected || !call || (call.phase !== "idle" && call.phase !== "ended")}
            onClick={() => void callRef.current?.startCall("video")}
            aria-label="Видео разговор"
          >
            Видео
          </button>
        </div>
        <div>
          <strong>{contact.name}</strong>
          <span className={connected ? "status on" : "status off"}>
            {connected ? " · свързан" : " · връзката е прекъсната"}
          </span>
        </div>
      </header>

      {notice && <p role="alert" className="chat-notice">{notice}</p>}

      {confirmWipe && (
        <section className="call-panel" aria-label="Потвърди изтриването">
          <p>Чатът ще се изтрие и при двама ви. Това не може да се отмени.</p>
          <div className="call-actions">
            <button onClick={onWipeChat}>Да, изтрий за двамата</button>
            <button className="secondary" onClick={() => setConfirmWipe(false)}>
              Не
            </button>
          </div>
        </section>
      )}

      {call && (
        <CallPanel
          call={call}
          contactName={contact.name}
          onAccept={() => void callRef.current?.accept()}
          onDecline={() => void callRef.current?.decline()}
          onHangup={() => void callRef.current?.hangup()}
          onToggleMute={() => callRef.current?.setMuted(!call.muted)}
          onToggleCamera={() => callRef.current?.setCameraOff(!call.cameraOff)}
        />
      )}

      <ol className="messages">
        {messages.map((m, i) => (
          <li key={`${m.timestamp}-${i}`} className={m.direction === "out" ? "msg out" : "msg in"}>
            {m.location ? (
              <LocationBubble fix={m.location} />
            ) : m.image ? (
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
          disabled={!connected || !!transfer || locating}
          onClick={onShareLocation}
          aria-label="Сподели точната си локация"
        >
          {locating ? "Локация…" : "Локация"}
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

/** A shared location. The map link is opened only if the person taps it. */
function LocationBubble({ fix }: { fix: { lat: number; lng: number; accuracy: number } }) {
  const coords = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`;
  const url = `https://www.openstreetmap.org/?mlat=${fix.lat}&mlon=${fix.lng}#map=17/${fix.lat}/${fix.lng}`;
  return (
    <span className="msg-location">
      <strong>Локация</strong> {coords}
      <br />
      <small>точност ±{fix.accuracy} м</small>
      <br />
      <a href={url} target="_blank" rel="noopener noreferrer">
        Покажи на картата
      </a>
    </span>
  );
}
