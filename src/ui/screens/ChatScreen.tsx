import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { notifyIncoming, previewText } from "../../notify/notifier";
import type { Contact } from "../../contacts/contacts";
import { DISAPPEAR_OPTIONS, disappearLabel } from "../../history/disappearing";
import { useDisappearingTimer } from "../useDisappearingTimer";
import { useChatFiles } from "../useChatFiles";
import {
  appendMessage,
  deleteHistory,
  loadHistory,
  validLocation,
  type ChatMessage,
} from "../../history/messageStore";
import { deleteFilesFor, loadFile } from "../../history/fileStore";
import { MAX_FILE_BYTES } from "../../p2p/fileTransfer";
import { FileBubble, TransferList } from "../components/FileBubble";
import { PastePreview } from "../components/PastePreview";
import { usePasteImage } from "../pasteImage";
import { decodeControl, encodeControl, isControlMessage, type ControlMessage, type VouchMessage } from "../../p2p/control";
import type { PeerLink } from "../../p2p/peer";
import { isEncryptedMessage, type SecureSession } from "../../p2p/secureSession";
import { buildPhotoFrames, PhotoReceiver, sanitizeText, sniffMime } from "../../p2p/photo";
import { prepareImage } from "../image";
import { isCallSignal } from "../../call/signal";
import { useChatCall } from "../useChatCall";
import { CallPanel } from "../components/CallPanel";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { KeyContinuityPanel } from "../components/KeyContinuityPanel";
import { useKeyContinuity, type Me } from "../useKeyContinuity";
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
  /** Me (П7: signing "this is the new key of …"). Without it the key-continuity panel is hidden. */
  me?: Me;
}

export function ChatScreen({ contact, link, session, historyKey, onClose, me }: ChatScreenProps) {
  const { t, locale } = useI18n();
  // The mounted effect below runs once, so it reads the latest translator through a ref.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // П7: key continuity (src/trust, docs/KEY-CONTINUITY.md).
  const sendVouch = useCallback(async (m: VouchMessage) => link.send(await session.seal(encodeControl(m))), [link, session]);
  const kc = useKeyContinuity(contact, me, sendVouch);
  const kcRef = useRef(kc);
  useEffect(() => {
    kcRef.current = kc;
  });
  useEffect(() => {
    if (kc.notice) setNotice(kc.notice);
  }, [kc.notice]);
  const [connected, setConnected] = useState(link.isOpen());
  // Disappearing messages (Н7): the same value on both sides (history/timerSync.ts).
  const { timerMs, sync: timer, withTimer } = useDisappearingTimer(contact);
  const [transfer, setTransfer] = useState<{ label: string; done: number; total: number } | null>(null);
  const receiverRef = useRef(new PhotoReceiver());
  const [locating, setLocating] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  // Cipher-suite agreement. The ref is read by the receive loop; the state drives the panel.
  const suiteRef = useRef<NegotiationState>(initialNegotiation());
  const [suiteView, setSuiteView] = useState<NegotiationState>(initialNegotiation());
  const [showCrypto, setShowCrypto] = useState(false);
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** A picture pasted with Ctrl+V, waiting for "Send". */
  const [pasted, setPasted] = useState<File | null>(null);

  // Sends and receives are chained so counters and chain keys advance in order.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queueRef.current.then(task, task);
    queueRef.current = next.catch(() => undefined);
    return next;
  };

  /** Writes a message (with the chat's timer) to the history and shows it. */
  async function addMessage(msg: ChatMessage): Promise<void> {
    const kept = withTimer(msg);
    await appendMessage(historyKey, contact.did, kept);
    setMessages((prev) => [...prev, kept]);
  }

  // Calls (Н6): the controller on this link (ui/useChatCall.ts).
  const calls = useChatCall(link, session, enqueue);
  const { call, cameras } = calls;
  const callRef = calls.controller;

  // Files (Н5): transfers on this link, resumable across links (ui/useChatFiles.ts).
  const files = useChatFiles({
    link,
    session,
    enqueue,
    historyKey,
    contact,
    addMessage,
    notice: (text) => setNotice(tRef.current(text)),
    incoming: (name) => alertIncomingRef.current(tRef.current("Файл: {name}", { name })),
  });
  // Set by the mounted effect (it needs the contact's notification settings).
  const alertIncomingRef = useRef<(preview: string) => void>(() => undefined);

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

    // A peer from before protocol version 2 (Н10): say what will not work with it.
    if (link.peerProtocol && link.peerProtocol.pv < 2) {
      setNotice(tRef.current("Другият човек е със стара версия: прекъснатите файлове няма да продължат и изчезващите съобщения няма да работят при него."));
    }

    // A sound and, with the window in the background, a system notification (src/notify).
    const alertIncoming = (preview: string) =>
      notifyIncoming(
        {
          chatId: `chat:${contact.did}`,
          known: contact.verified,
          title: contact.name,
          preview,
          hidden: tRef.current("Ново съобщение"),
        },
        true,
      );
    alertIncomingRef.current = alertIncoming;

    const off = link.onMessage((text) => {
      if (!isEncryptedMessage(text)) return;
      void enqueue(async () => {
        try {
          const plaintext = await session.open(text);
          if (isCallSignal(plaintext)) {
            calls.handleFrame(plaintext);
            return;
          }
          if (isControlMessage(plaintext)) {
            const control = decodeControl(plaintext);
            if (!control) return;
            if (control.t === "suite") {
              if (alive) onSuiteMessage(control);
              return;
            }
            if (control.t === "vouch-grant" || control.t === "vouch-ask" || control.t === "vouch-list") {
              await kcRef.current.handle(control);
              return;
            }
            if (control.t === "timer") {
              const result = await timer.receive({ ms: control.ms, at: control.at });
              if (alive && result === "changed-value") {
                setNotice(
                  control.ms
                    ? tRef.current("{name} включи изчезващи съобщения: {time}.", {
                        name: contact.name,
                        time: tRef.current(disappearLabel(control.ms)),
                      })
                    : tRef.current("{name} изключи изчезващите съобщения.", { name: contact.name }),
                );
              }
              return;
            }
            if (control.t === "wipe") {
              receiverRef.current.discardInProgress();
              files.forgetAll();
              await deleteHistory(contact.did);
              await deleteFilesFor(contact.did);
              if (alive) {
                setTransfer(null);
                setMessages([]);
                setNotice(tRef.current("Другият човек изтри чата. Историята е изтрита и тук."));
              }
              return;
            }
            const located: ChatMessage = withTimer({ text: "", location: control.fix, direction: "in", timestamp: Date.now() });
            await appendMessage(historyKey, contact.did, located);
            if (alive) setMessages((prev) => [...prev, located]);
            alertIncoming(tRef.current("Местоположение"));
            return;
          }
          if (files.filesRef.current?.handleControl(plaintext)) return;
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
          const msg: ChatMessage = withTimer(
            result.kind === "photo"
              ? { text: "", image: result.dataUrl, direction: "in", timestamp: Date.now() }
              : { text: result.text, direction: "in", timestamp: Date.now() },
          );
          await appendMessage(historyKey, contact.did, msg);
          if (alive) {
            setTransfer(null);
            setMessages((prev) => [...prev, msg]);
          }
          alertIncoming(msg.image ? tRef.current("Снимка") : previewText(msg.text));
        } catch (err) {
          if (alive) setNotice(tRef.current(err instanceof Error ? err.message : "Съобщението не можа да се разшифрова."));
        }
      });
    });

    // Both sides send their timer setting when the chat opens, so settings changed while
    // apart (or on a moved device) converge; the receiver keeps whichever newerTimer() picks.
    void enqueue(async () => {
      try {
        link.send(await session.seal(encodeControl({ t: "timer", ...timer.current() })));
      } catch {
        /* not connected: the next chat sends it */
      }
    });

    const ticker = setInterval(() => {
      if (!alive) return;
      setConnected(link.isOpen());
      // Expired messages leave the screen, and the decrypted copy of an expired file is
      // released; App.tsx deletes the rows and kept files from the device.
      const now = Date.now();
      const expired = messagesRef.current.filter((m) => m.expiresAt !== undefined && m.expiresAt <= now);
      if (expired.length === 0) return;
      files.release(expired.flatMap((m) => (m.file ? [m.file.id] : [])));
      setMessages((prev) => prev.filter((m) => m.expiresAt === undefined || m.expiresAt > now));
    }, 1000);
    return () => {
      alive = false;
      off();
      clearInterval(ticker);
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
        const msg: ChatMessage = withTimer({ text, direction: "out", timestamp: Date.now() });
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
            const msg: ChatMessage = withTimer({ text: "", location: fix, direction: "out", timestamp: Date.now() });
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
      files.forgetAll();
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

  /** Turns the chat's timer on, changes or turns it off for both people. Needs the link. */
  function onChooseTimer(ms: number) {
    if (ms === timer.ms) return;
    setNotice(null);
    void enqueue(async () => {
      try {
        const changed = await timer.choose(ms, async (setting) => {
          link.send(await session.seal(encodeControl({ t: "timer", ...setting })));
        });
        if (!changed) return;
      } catch {
        setNotice(t("Връзката е прекъсната. Опитайте отново, когато се свържете."));
        return;
      }
      setNotice(
        ms
          ? t("Изчезващи съобщения: {time}. Важи за новите съобщения и при двама ви.", { time: t(disappearLabel(ms)) })
          : t("Изчезващите съобщения са изключени."),
      );
    });
  }

  /** Sends any file up to 100 MB. The other side sees a card and decides whether to take it. */
  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    if (file.size > MAX_FILE_BYTES) {
      setNotice(t("Файлът е по-голям от {mb} MB.", { mb: Math.round(MAX_FILE_BYTES / 1048576) }));
      return;
    }
    try {
      await files.sendFile(file);
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
          const msg: ChatMessage = withTimer({ text: "", image: url, direction: "out", timestamp: Date.now() });
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
            title={link.native ? t("Разговорите не работят през експерименталния нативен транспорт.") : undefined}
          >
            {t("Аудио")}
          </button>
          <button
            className="secondary"
            disabled={!connected || !call || (call.phase !== "idle" && call.phase !== "ended")}
            onClick={() => void callRef.current?.startCall("video")}
            aria-label={t("Видео разговор")}
            title={link.native ? t("Разговорите не работят през експерименталния нативен транспорт.") : undefined}
          >
            {t("Видео")}
          </button>
        </div>
        <div>
          <strong>{contact.name}</strong>
          <span className={connected ? "status on" : "status off"}>
            {connected ? t(" · свързан") : t(" · връзката е прекъсната")}
          </span>
          {timerMs > 0 && (
            <span className="status timer" title={t("Изчезващи съобщения")}>
              {" · ⏱ "}
              {t(disappearLabel(timerMs))}
            </span>
          )}
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
          <label className="timer-row">
            <strong>{t("Изчезващи съобщения")}:</strong>{" "}
            <select value={timerMs} disabled={!connected} onChange={(e) => onChooseTimer(Number(e.target.value))}>
              {DISAPPEAR_OPTIONS.map((ms) => (
                <option key={ms} value={ms}>
                  {t(disappearLabel(ms))}
                </option>
              ))}
            </select>
          </label>
          <p>
            {t(
              "Новите съобщения се изтриват от двете устройства след избраното време. Другият човек пак може да ги снима или копира, преди да изчезнат.",
            )}
          </p>
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
          <KeyContinuityPanel me={me} kc={kc} send={sendVouch} />
        </section>
      )}

      {kc.current.replacedBy && (
        <p role="note" className="chat-notice">
          {t("{name} вече има нов ключ ({new}). Пишете си там.", { name: contact.name, new: kc.current.replacedBy.name })}
        </p>
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
          onSwitchCamera={cameras && callRef.current?.canSwitchCamera ? () => void callRef.current?.switchCamera() : undefined}
          onToggleScreen={callRef.current?.canShareScreen || call.sharing ? () => void callRef.current?.toggleScreenShare() : undefined}
        />
      )}

      {/* Scrollable region: focusable so keyboard users can scroll the history. */}
      <ol className="messages" tabIndex={0} aria-label={t("Съобщения")}>
        {messages.map((m, i) => (
          <li key={`${m.timestamp}-${i}`} className={m.direction === "out" ? "msg out" : "msg in"}>
            {m.file ? (
              <FileBubble
                card={m.file}
                url={files.urlFor(m.file.id)}
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

      {files.preparing && (
        <p className="chat-notice" role="status">
          {t("Подготвям „{name}“…", { name: files.preparing })}
        </p>
      )}
      <TransferList
        items={files.active}
        onAccept={files.accept}
        onCancel={(id) => {
          files.cancel(id);
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
          disabled={!connected || !!files.preparing}
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
