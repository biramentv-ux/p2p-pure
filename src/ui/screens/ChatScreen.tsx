import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Contact } from "../../contacts/contacts";
import {
  appendMessage,
  deleteHistory,
  loadHistory,
  validLocation,
  type ChatMessage,
  type FileCard,
} from "../../history/messageStore";
import { canStore, deleteFilesFor, loadFile, saveFile } from "../../history/fileStore";
import { FileTransfers, MAX_FILE_BYTES, type FileMeta } from "../../p2p/fileTransfer";
import { FileBubble, TransferList, type ActiveTransfer } from "../components/FileBubble";
import { PastePreview } from "../components/PastePreview";
import { usePasteImage } from "../pasteImage";
import { decodeControl, encodeControl, isControlMessage, type ControlMessage } from "../../p2p/control";
import type { PeerLink } from "../../p2p/peer";
import { isEncryptedMessage, type SecureSession } from "../../p2p/secureSession";
import { buildPhotoFrames, PhotoReceiver, sanitizeText, sniffMime } from "../../p2p/photo";
import { prepareImage } from "../image";
import { CallController, type CallSnapshot } from "../../call/callController";
import { encodeSignal, isCallSignal, SignalAssembler } from "../../call/signal";
import { acquireMedia } from "../../call/media";
import { CallPanel } from "../components/CallPanel";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useI18n } from "../../i18n";
import { CIPHER_SUITES, suiteLabel, type CipherSuite } from "../../p2p/cipherSuite";
import {
  answerIncoming,
  initialNegotiation,
  newProposalId,
  proposeSuite,
  receiveSuiteMessage,
  type NegotiationState,
  type Step,
} from "../../p2p/suiteNegotiation";

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
  const { t, locale } = useI18n();
  // The mounted effect below runs once, so it reads the latest translator through a ref.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });
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
  // Cipher-suite agreement. The ref is read by the receive loop; the state drives the panel.
  const suiteRef = useRef<NegotiationState>(initialNegotiation());
  const [suiteView, setSuiteView] = useState<NegotiationState>(initialNegotiation());
  const [showCrypto, setShowCrypto] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Files: transfers on this link, the ones in progress, and object URLs made in this session.
  const filesRef = useRef<FileTransfers | null>(null);
  const [active, setActive] = useState<ActiveTransfer[]>([]);
  const [preparing, setPreparing] = useState<string | null>(null);
  /** A picture pasted with Ctrl+V, waiting for "Send". */
  const [pasted, setPasted] = useState<File | null>(null);
  const urlsRef = useRef(new Map<string, string>());

  function upsertActive(item: ActiveTransfer) {
    setActive((prev) => [...prev.filter((a) => a.id !== item.id), item]);
  }
  function dropActive(id: string) {
    setActive((prev) => prev.filter((a) => a.id !== id));
  }
  /** Keeps a file (up to 25 MB) encrypted on the device and returns its card for the history. */
  async function keepFile(meta: FileMeta, blob: Blob): Promise<FileCard> {
    const url = URL.createObjectURL(blob);
    urlsRef.current.set(meta.id, url);
    let stored = canStore(meta.size);
    if (stored) {
      try {
        await saveFile(historyKey, contact.did, meta.id, blob);
      } catch {
        stored = false;
      }
    }
    return { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, stored };
  }

  // Sends and receives are chained so counters and chain keys advance in order.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(task, task);
    queueRef.current = next.catch(() => undefined);
    return next;
  };

  /** Applies a negotiation step: stores the new state, switches the send suite, sends the reply. */
  function runSuiteStep(step: Step) {
    suiteRef.current = step.state;
    setSuiteView(step.state);
    if (step.activate) {
      session.setSendSuite(step.activate);
      setNotice(tRef.current("Методът е сменен на {suite}.", { suite: suiteLabel(step.activate) }));
    }
    if (step.rejected) setNotice(tRef.current("Този метод вече е активен."));
    if (step.send) {
      const message = step.send;
      void enqueue(async () => {
        try {
          link.send(await session.seal(encodeControl(message)));
        } catch {
          setNotice(tRef.current("Връзката е прекъсната. Опитайте отново, когато се свържете."));
        }
      });
    }
  }

  function onSuiteMessage(message: Extract<ControlMessage, { t: "suite" }>) {
    if (message.op === "decline" && suiteRef.current.outgoing?.id === message.id) {
      setNotice(tRef.current("Събеседникът отказа смяната на метода."));
    }
    if (message.op === "propose") setShowCrypto(true);
    runSuiteStep(receiveSuiteMessage(suiteRef.current, message));
  }

  useEffect(() => {
    let alive = true;
    // Queued like every other operation: a wipe that arrives while the history is still
    // decrypting must run after the load, or the old list would come back on screen.
    void enqueue(async () => {
      try {
        const history = await loadHistory(historyKey, contact.did);
        if (alive) setMessages(history);
      } catch {
        if (alive) setNotice(tRef.current("Историята не можа да се прочете."));
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

    const files = new FileTransfers(
      {
        sendControl: (plaintext) =>
          enqueue(async () => {
            link.send(await session.seal(plaintext));
          }),
        sendBinary: (bytes) => link.sendBinary(bytes),
      },
      {
        offered: (m) => alive && upsertActive({ id: m.id, name: m.name, size: m.size, direction: "in", phase: "offer", done: 0 }),
        outgoing: (m) => {
          if (!alive) return;
          setPreparing(null);
          upsertActive({ id: m.id, name: m.name, size: m.size, direction: "out", phase: "waiting", done: 0 });
        },
        progress: (id, done) =>
          alive && setActive((prev) => prev.map((a) => (a.id === id ? { ...a, phase: "moving", done } : a))),
        received: (meta, blob) => {
          void (async () => {
            const card = await keepFile(meta, blob);
            const msg: ChatMessage = { text: "", file: card, direction: "in", timestamp: Date.now() };
            await appendMessage(historyKey, contact.did, msg);
            if (!alive) return;
            dropActive(meta.id);
            setMessages((prev) => [...prev, msg]);
          })();
        },
        sent: () => undefined,
        failed: (id, reason) => {
          if (!alive) return;
          dropActive(id);
          if (reason !== "Отказано.") setNotice(tRef.current(reason));
        },
      },
      MAX_FILE_BYTES,
    );
    filesRef.current = files;
    const urls = urlsRef.current;
    const offBinary = link.onBinary((bytes) => {
      files.handleBinary(bytes);
    });

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
            if (control.t === "suite") {
              if (alive) onSuiteMessage(control);
              return;
            }
            if (control.t === "wipe") {
              receiverRef.current.discardInProgress();
              await deleteHistory(contact.did);
              await deleteFilesFor(contact.did);
              if (alive) {
                setTransfer(null);
                setMessages([]);
                setNotice(tRef.current("Другият човек изтри чата. Историята е изтрита и тук."));
              }
              return;
            }
            const located: ChatMessage = { text: "", location: control.fix, direction: "in", timestamp: Date.now() };
            await appendMessage(historyKey, contact.did, located);
            if (alive) setMessages((prev) => [...prev, located]);
            return;
          }
          if (filesRef.current?.handleControl(plaintext)) return;
          const result = receiverRef.current.feed(plaintext);
          if (result.kind === "discarded") return;
          if (result.kind === "progress") {
            if (alive) setTransfer({ label: "Получавам снимка", done: result.received, total: result.total });
            return;
          }
          if (result.kind === "rejected") {
            if (alive) {
              setTransfer(null);
              setNotice(tRef.current(result.reason));
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
          if (alive) setNotice(tRef.current(err instanceof Error ? err.message : "Съобщението не можа да се разшифрова."));
        }
      });
    });

    const timer = setInterval(() => alive && setConnected(link.isOpen()), 1000);
    return () => {
      alive = false;
      off();
      offBinary();
      files.close();
      filesRef.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
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
        setNotice(t(err instanceof Error ? err.message : "Съобщението не беше изпратено."));
      }
    });
  }

  /** Asks the device for a precise fix once, then sends it. Nothing is sent without a tap. */
  function onShareLocation() {
    setNotice(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setNotice(t("Устройството не поддържа локация."));
      return;
    }
    setLocating(true);
    // Some browsers never answer an unanswered permission prompt. Do not leave the button stuck.
    let answered = false;
    const guard = setTimeout(() => {
      if (answered) return;
      answered = true;
      setLocating(false);
      setNotice(t("Не успях да определя локацията навреме. Провери разрешението за локация."));
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
          setNotice(t("Не успях да определя локацията."));
          return;
        }
        void enqueue(async () => {
          try {
            link.send(await session.seal(encodeControl({ t: "loc", fix })));
            const msg: ChatMessage = { text: "", location: fix, direction: "out", timestamp: Date.now() };
            await appendMessage(historyKey, contact.did, msg);
            setMessages((prev) => [...prev, msg]);
          } catch (err) {
            setNotice(t(err instanceof Error ? err.message : "Локацията не беше изпратена."));
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
            ? t("Нямаш разрешение за локацията.")
            : code === 3
              ? t("Определянето на локацията отне твърде дълго.")
              : t("Не успях да определя локацията."),
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
      for (const a of active) void filesRef.current?.cancel(a.id);
      await deleteHistory(contact.did);
      await deleteFilesFor(contact.did);
      setMessages([]);
      setTransfer(null);
      setNotice(
        delivered
          ? t("Чатът е изтрит и за двамата.")
          : t("Чатът е изтрит тук. Другият човек не беше на линия, затова няма да се изтрие при него."),
      );
    });
  }

  /** Sends any file up to 100 MB. The other side sees a card and decides whether to take it. */
  async function onPickFile(file: File | undefined) {
    const files = filesRef.current;
    if (!file || !files) return;
    setNotice(null);
    if (file.size > MAX_FILE_BYTES) {
      setNotice(t("Файлът е по-голям от {mb} MB.", { mb: Math.round(MAX_FILE_BYTES / 1048576) }));
      return;
    }
    setPreparing(file.name);
    try {
      const sending = files.send(file, file.name);
      // The offer is out once the file is hashed; from then on the list shows its progress.
      const meta = await sending.finally(() => setPreparing(null));
      const card = await keepFile(meta, new Blob([file], { type: meta.mime }));
      const msg: ChatMessage = { text: "", file: card, direction: "out", timestamp: Date.now() };
      await appendMessage(historyKey, contact.did, msg);
      dropActive(meta.id);
      setMessages((prev) => [...prev, msg]);
    } catch (err) {
      setNotice(t(err instanceof Error ? err.message : "Файлът не беше изпратен."));
    }
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
      setNotice(t(err instanceof Error ? err.message : "Снимката не беше изпратена."));
    }
  }

  usePasteImage(connected, setPasted);

  return (
    <div className="chat">
      <header className="chat-header">
        <button className="secondary" onClick={onClose}>
          {t("Назад")}
        </button>
        <div className="call-buttons">
          <button
            className="secondary"
            disabled={!connected}
            onClick={() => setConfirmWipe(true)}
            aria-label={t("Изтрий чата за двамата")}
          >
            {t("Изтрий чата")}
          </button>
          <button
            className="secondary"
            disabled={!connected || !call || (call.phase !== "idle" && call.phase !== "ended")}
            onClick={() => void callRef.current?.startCall("audio")}
            aria-label={t("Аудио разговор")}
          >
            {t("Аудио")}
          </button>
          <button
            className="secondary"
            disabled={!connected || !call || (call.phase !== "idle" && call.phase !== "ended")}
            onClick={() => void callRef.current?.startCall("video")}
            aria-label={t("Видео разговор")}
          >
            {t("Видео")}
          </button>
        </div>
        <div>
          <strong>{contact.name}</strong>
          <span className={connected ? "status on" : "status off"}>
            {connected ? t(" · свързан") : t(" · връзката е прекъсната")}
          </span>
        </div>
        <button
          className="secondary"
          onClick={() => setShowCrypto((v) => !v)}
          aria-expanded={showCrypto}
          aria-controls="crypto-panel"
        >
          {t("Криптография")}
        </button>
        <LanguageSwitch />
      </header>

      {showCrypto && (
        <section id="crypto-panel" className="call-panel" aria-label={t("Криптографски настройки")}>
          <p>
            <strong>{t("Текущ метод")}:</strong> {suiteLabel(suiteView.active)}
          </p>
          <p>
            {t(
              "Промяната влиза в сила само когато и двамата я потвърдите. Ключовете и Double Ratchet остават същите; сменя се само шифроването на съобщенията.",
            )}
          </p>
          {suiteView.incoming && (
            <div role="group" aria-label={t("Предложение за смяна")}>
              <p>{t("Събеседникът предлага {suite}.", { suite: suiteLabel(suiteView.incoming.suite) })}</p>
              <div className="call-actions">
                <button onClick={() => runSuiteStep(answerIncoming(suiteRef.current, true))}>{t("Приеми")}</button>
                <button className="secondary" onClick={() => runSuiteStep(answerIncoming(suiteRef.current, false))}>
                  {t("Откажи")}
                </button>
              </div>
            </div>
          )}
          {suiteView.outgoing && (
            <p role="status">
              {t("Чака потвърждение от събеседника за {suite}.", { suite: suiteLabel(suiteView.outgoing.suite) })}
            </p>
          )}
          <div className="call-actions">
            {CIPHER_SUITES.filter((suite: CipherSuite) => suite !== suiteView.active).map((suite) => (
              <button
                key={suite}
                className="secondary"
                disabled={!connected || suiteView.outgoing !== null}
                onClick={() => {
                  const step = proposeSuite(suiteRef.current, suite, newProposalId());
                  runSuiteStep(step);
                }}
              >
                {t("Предложи {suite}", { suite: suiteLabel(suite) })}
              </button>
            ))}
          </div>
        </section>
      )}

      {notice && <p role="alert" className="chat-notice">{notice}</p>}

      {confirmWipe && (
        <section className="call-panel" aria-label={t("Потвърди изтриването")}>
          <p>{t("Чатът ще се изтрие и при двама ви. Това не може да се отмени.")}</p>
          <div className="call-actions">
            <button onClick={onWipeChat}>{t("Да, изтрий за двамата")}</button>
            <button className="secondary" onClick={() => setConfirmWipe(false)}>
              {t("Не")}
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

      {/* Scrollable region: focusable so keyboard users can scroll the history. */}
      <ol className="messages" tabIndex={0} aria-label={t("Съобщения")}>
        {messages.map((m, i) => (
          <li key={`${m.timestamp}-${i}`} className={m.direction === "out" ? "msg out" : "msg in"}>
            {m.file ? (
              <FileBubble
                card={m.file}
                url={urlsRef.current.get(m.file.id)}
                load={() => loadFile(historyKey, contact.did, m.file!.id)}
              />
            ) : m.location ? (
              <LocationBubble fix={m.location} />
            ) : m.image ? (
              <img className="msg-image" src={m.image} alt={t("Снимка")} />
            ) : (
              <span className="msg-text">{m.text}</span>
            )}
            <time>{new Date(m.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
          </li>
        ))}
        {messages.length === 0 && <li className="empty">{t("Няма съобщения още. Кажи здравей.")}</li>}
      </ol>

      {transfer && (
        <p className="chat-notice" role="status">
          {t("{label}: {percent}%", {
            label: t(transfer.label),
            percent: Math.min(100, Math.round((transfer.done / transfer.total) * 100)),
          })}
        </p>
      )}

      {preparing && (
        <p className="chat-notice" role="status">
          {t("Подготвям „{name}“…", { name: preparing })}
        </p>
      )}
      <TransferList
        items={active}
        onAccept={(id) => void filesRef.current?.accept(id)}
        onCancel={(id) => {
          dropActive(id);
          void filesRef.current?.cancel(id);
        }}
      />

      <input
        ref={fileInput}
        type="file"
        hidden
        onChange={(e) => {
          void onPickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
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

      {pasted && (
        <PastePreview
          file={pasted}
          busy={!!transfer}
          onCancel={() => setPasted(null)}
          onSend={() => {
            const file = pasted;
            setPasted(null);
            void onPickPhoto(file);
          }}
        />
      )}

      <form className="composer" onSubmit={onSend}>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!transfer}
          onClick={() => cameraInput.current?.click()}
          aria-label={t("Снимай с камерата")}
        >
          {t("Камера")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!transfer || locating}
          onClick={onShareLocation}
          aria-label={t("Сподели точната си локация")}
        >
          {locating ? t("Локация…") : t("Локация")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!transfer}
          onClick={() => galleryInput.current?.click()}
          aria-label={t("Избери снимка от галерията")}
        >
          {t("Галерия")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!connected || !!preparing}
          onClick={() => fileInput.current?.click()}
          aria-label={t("Прикачи файл или видео до 100 MB")}
        >
          {t("Файл")}
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("Съобщение")}
          maxLength={4000}
          aria-label={t("Съобщение")}
          disabled={!connected}
        />
        <button type="submit" disabled={!connected || !draft.trim()}>
          {t("Изпрати")}
        </button>
      </form>
    </div>
  );
}

/** A shared location. The map link is opened only if the person taps it. */
function LocationBubble({ fix }: { fix: { lat: number; lng: number; accuracy: number } }) {
  const { t } = useI18n();
  const coords = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`;
  const url = `https://www.openstreetmap.org/?mlat=${fix.lat}&mlon=${fix.lng}#map=17/${fix.lat}/${fix.lng}`;
  return (
    <span className="msg-location">
      <strong>{t("Локация")}</strong> {coords}
      <br />
      <small>{t("точност ±{accuracy} м", { accuracy: fix.accuracy })}</small>
      <br />
      <a href={url} target="_blank" rel="noopener noreferrer">
        {t("Покажи на картата")}
      </a>
    </span>
  );
}
