import { useEffect, useRef, useState } from "react";
import { copyWithAutoClear } from "../clipboard";
import { publicKeyToDidKey } from "../../identity/didKey";
import type { UnlockedIdentity } from "../../identity";
import { CONTACT_LIMIT_MESSAGE, ContactLimitError, canAddContact, saveContact, type Contact } from "../../contacts/contacts";
import {
  assertKind,
  bytesEqual,
  createInvitation,
  encodeInvitation,
  encodeInvitationHex,
  InvitationError,
  type Invitation,
} from "../../p2p/invitation";
import { PeerLink, PeerLinkError, CONNECT_TIMEOUT_MS } from "../../p2p/peer";
import { describeReachability, reachability, summarizeCandidates } from "../../p2p/network";
import { completeHandshake } from "../../p2p/session";
import { createEphemeralKeyPair, SecureSession, type EphemeralKeyPair } from "../../p2p/secureSession";
import { formatSafetyCode, safetyWords } from "../../p2p/safety";
import { identityX25519Public } from "../../identity/x25519";
import { useI18n } from "../../i18n";
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { PairingCodeEnter, PairingCodeShare, ShortCodeEnter, ShortCodeShare } from "../components/ShortCode";
import { OfflineSignalingProvider } from "../../signaling/offlineProvider";
import { PakeError, PakeSignalingProvider } from "../../signaling/pakeProvider";
import { getSignalMode, setSignalMode, type SignalMode } from "../../signaling/mode";
import { isBleSupported } from "../../platform/mobile/blePairing";
import { BlePairingPanel } from "../components/BlePairingPanel";
import type { PairingCode } from "../../p2p/pairingCode";
import { parseScannedInvitation, toSignalingPayload } from "../../signaling/invitationPayload";

export interface ConnectedResult {
  contact: Contact;
  link: PeerLink;
  session: SecureSession;
}

interface ConnectScreenProps {
  identity: UnlockedIdentity;
  /** Set when reconnecting to an already verified contact: skips the safety step. */
  expected?: Contact;
  onConnected: (result: ConnectedResult) => void;
  onCancel: () => void;
}

/** Responder waits longer: the initiator has to scan the answer first. */
const RESPONDER_TIMEOUT_MS = 5 * 60_000;

type View =
  | { k: "choose" }
  | { k: "busy"; label: string; cancellable?: boolean }
  | { k: "offer-qr"; payload: string; hex: string; net: string }
  | { k: "scan-answer" }
  | { k: "scan-offer" }
  | { k: "demo-wait"; code: PairingCode; net: string; matched: boolean }
  | { k: "demo-join" }
  | { k: "ble"; role: "initiator" | "responder"; offer?: string }
  | { k: "answer-qr"; payload: string; hex: string; net: string }
  | {
      k: "confirm";
      peerPublicKey: Uint8Array;
      words: string[];
      link: PeerLink;
      session: SecureSession;
    };

/** Text version of the QR payload, for a device without a camera. Selectable and copyable. */
function HexFallback({ hex }: { hex: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await copyWithAutoClear(hex);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <details>
      <summary>{t("Няма камера на другото устройство?")}</summary>
      <p>
        {t(
          "Копирай този код и го изпрати по сигурен начин. Другият човек го поставя с „Няма камера?“.",
        )}
      </p>
      <textarea
        readOnly
        rows={4}
        value={hex}
        aria-label={t("Покана като hex")}
        onFocus={(e) => e.target.select()}
      />
      <button type="button" className="secondary" onClick={() => void copy()}>
        {copied ? t("Копирано") : t("Копирай кода")}
      </button>
    </details>
  );
}

export function ConnectScreen({ identity, expected, onConnected, onCancel }: ConnectScreenProps) {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ k: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  const linkRef = useRef<PeerLink | null>(null);
  const offerRef = useRef<Invitation | null>(null);
  const ephemeralRef = useRef<EphemeralKeyPair | null>(null);
  /** Our own SDP, kept so a failed connection can explain this network's reachability. */
  const mySdpRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  // Offline signaling: generated offers and answers come back through the provider.
  const providerRef = useRef<OfflineSignalingProvider | null>(null);
  const pendingHexRef = useRef<string>("");
  // Demo signalling: an open PAKE room connection, and the mode the user picked (persisted).
  const wsRef = useRef<PakeSignalingProvider | null>(null);
  // Bluetooth is offered only in the native apps; a stored "ble" choice falls back to local elsewhere.
  const bleSupported = isBleSupported();
  const [mode, setMode] = useState<SignalMode>(() => {
    const stored = getSignalMode();
    return stored === "ble" && !bleSupported ? "local" : stored;
  });
  // Bluetooth responder: the panel waits for the answer invitation to send back.
  const bleAnswerRef = useRef<{ resolve: (answer: string) => void; reject: (err: unknown) => void } | null>(null);
  useEffect(
    () => () => {
      wsRef.current?.disconnect();
      wsRef.current = null;
    },
    [],
  );
  // A full book (99) is said before a connection is started; a saved contact can still reconnect.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (expected) return;
    let alive = true;
    canAddContact()
      .then((ok) => alive && setFull(!ok))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [expected]);

  function getProvider(): OfflineSignalingProvider {
    if (!providerRef.current) {
      const provider = new OfflineSignalingProvider();
      provider.onLocalPayloadGenerated((payload) => {
        const net = t(describeReachability(summarizeCandidates(payload.sdp)));
        const invitation = payload.invitation ?? "";
        const hex = pendingHexRef.current;
        if (payload.type === "offer") setView({ k: "offer-qr", payload: invitation, hex, net });
        else setView({ k: "answer-qr", payload: invitation, hex, net });
      });
      providerRef.current = provider;
    }
    return providerRef.current;
  }
  const doneRef = useRef(false);

  useEffect(() => {
    return () => {
      if (!doneRef.current) linkRef.current?.close();
    };
  }, []);

  function clearAll() {
    bleAnswerRef.current?.reject(new Error("cancelled"));
    bleAnswerRef.current = null;
    wsRef.current?.disconnect();
    wsRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    mySdpRef.current = null;
    offerRef.current = null;
    ephemeralRef.current = null;
    busyRef.current = false;
  }

  function fail(err: unknown) {
    const mySdp = mySdpRef.current;
    clearAll();
    mySdpRef.current = null;
    let message: string;
    if (err instanceof PakeError) {
      message = pakeErrorMessage(err);
    } else if (err instanceof PeerLinkError && mySdp) {
      // Timeouts and closed channels: say what it usually means and what to try next.
      const summary = summarizeCandidates(mySdp);
      message =
        reachability(summary) === "relay"
          ? [
              t("Връзката не се установи и през TURN релея. Провери адреса, потребителя и паролата му в раздел Идентичност."),
              t("Ако и другото устройство е зад строга мрежа, то също може да има нужда от релей."),
            ].join(" ")
          : [
              t("Връзката не се установи навреме. Мрежата може да блокира директната връзка."),
              t(describeReachability(summary)),
              t("Опитайте с една Wi-Fi мрежа за първото сдвояване."),
            ].join(" ");
    } else {
      message = err instanceof Error ? t(err.message) : t("Неизвестна грешка при свързване.");
    }
    setError(message);
    setView({ k: "choose" });
  }

  /** Demo room errors, in words a person can act on. The room is never retried. */
  function pakeErrorMessage(err: PakeError): string {
    switch (err.code) {
      case "wrong_code":
        return t("Кодът не съвпада. Започнете отначало с нов код.");
      case "timeout":
        return t("Времето изтече. Започнете отначало.");
      default:
        return t("Връзката през сървъра прекъсна. Опитайте пак.");
    }
  }

  function reset() {
    clearAll();
    setError(null);
    setView({ k: "choose" });
  }

  /** After a successful handshake: either finish (known contact) or show the safety code. */
  function afterHandshake(
    link: PeerLink,
    session: SecureSession,
    peerPublicKey: Uint8Array,
  ) {
    if (expected) {
      if (!bytesEqual(peerPublicKey, expected.publicKey)) {
        throw new Error("Другият човек не е същият контакт. Връзката е прекратена.");
      }
      doneRef.current = true;
      onConnected({ contact: expected, link, session });
      return;
    }
    const words = safetyWords(
      identityX25519Public(identity.keyPair.publicKey),
      identityX25519Public(peerPublicKey),
    );
    setView({ k: "confirm", peerPublicKey, words, link, session });
  }

  /* ---------- Initiator: show offer, then scan answer ---------- */

  async function startAsInitiator() {
    setError(null);
    setView({ k: "busy", label: t("Подготвям покана…") });
    try {
      const { link, sdp } = await PeerLink.createOffer();
      linkRef.current = link;
      mySdpRef.current = sdp;
      const eph = createEphemeralKeyPair();
      ephemeralRef.current = eph;
      const offer = createInvitation("offer", sdp, identity.keyPair, eph.publicKey);
      offerRef.current = offer;
      const payload = await encodeInvitation(offer);
      pendingHexRef.current = await encodeInvitationHex(offer);
      if (mode === "demo") {
        await startDemoOffer(offer, payload);
        return;
      }
      if (mode === "ble") {
        setView({ k: "ble", role: "initiator", offer: payload });
        return;
      }
      await getProvider().sendOffer(toSignalingPayload(offer, payload));
    } catch (err) {
      fail(err);
    }
  }

  async function onAnswerScanned(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    const link = linkRef.current;
    const offer = offerRef.current;
    const eph = ephemeralRef.current;
    try {
      if (!link || !offer || !eph) throw new Error("Няма активна покана.");
      const { invitation: answer } = await parseScannedInvitation(text);
      assertKind(answer, "answer");
      if (!answer.answersNonce || !bytesEqual(answer.answersNonce, offer.nonce)) {
        throw new InvitationError("Този отговор не е за тази покана.", "INVALID_FIELD");
      }
      setView({ k: "busy", label: t("Свързвам…") });
      await link.acceptAnswer(answer.sdp);
      await completeHandshake(link, identity.did, answer.publicKey, CONNECT_TIMEOUT_MS);
      const session = SecureSession.derive({
        role: "initiator",
        myIdentity: identity.keyPair,
        myEphemeral: eph,
        peerIdentityPublicKey: answer.publicKey,
        peerEphemeralPublicKey: answer.ephemeralPublicKey,
      });
      afterHandshake(link, session, answer.publicKey);
    } catch (err) {
      fail(err);
    } finally {
      busyRef.current = false;
    }
  }

  /* ---------- Responder: scan offer, show answer ---------- */

  function startAsResponder() {
    setError(null);
    setView(mode === "demo" ? { k: "demo-join" } : mode === "ble" ? { k: "ble", role: "responder" } : { k: "scan-offer" });
  }

  /**
   * Demo: opens a PAKE room and shows its code (room id + three words). The offer is sent only
   * after both sides proved they know the words, so the server never sees SDP or did:key.
   */
  async function startDemoOffer(offer: Invitation, payload: string) {
    const pake = new PakeSignalingProvider();
    wsRef.current = pake;
    pake.onAnswerReceived((p) => {
      if (p.invitation) void onAnswerScanned(p.invitation);
    });
    pake.onError((e) => {
      if (wsRef.current === pake) fail(e);
    });
    try {
      const code = await pake.openRoom();
      setView({
        k: "demo-wait",
        code,
        net: t(describeReachability(summarizeCandidates(mySdpRef.current ?? ""))),
        matched: false,
      });
      await pake.waitForPeer();
      setView((v) => (v.k === "demo-wait" ? { ...v, matched: true } : v));
      await pake.sendOffer(toSignalingPayload(offer, payload));
    } catch (err) {
      // Cancelled by the person (reset or leaving the screen): nothing to report.
      if (wsRef.current !== pake) return;
      throw err;
    }
  }

  /** Demo: joins the room named in the typed code, runs the PAKE, then waits for the offer. */
  async function startDemoJoin(code: PairingCode) {
    setError(null);
    setView({ k: "busy", label: t("Свързвам се със стаята…") });
    const pake = new PakeSignalingProvider();
    wsRef.current = pake;
    try {
      pake.onOfferReceived((p) => {
        if (p.invitation) void onOfferScanned(p.invitation);
      });
      pake.onError((e) => {
        if (wsRef.current === pake) fail(e);
      });
      await pake.joinRoom(code);
      setView({ k: "busy", label: t("Чакам другия човек…"), cancellable: true });
      await pake.waitForPeer();
      // The offer may already be in hand; then onOfferScanned owns the view.
      if (!busyRef.current) {
        setView({ k: "busy", label: t("Кодът съвпадна. Чакам поканата от другия човек…"), cancellable: true });
      }
    } catch (err) {
      if (wsRef.current !== pake) return;
      fail(err);
    }
  }

  async function onOfferScanned(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const { invitation: offer } = await parseScannedInvitation(text);
      assertKind(offer, "offer");
      // Over Bluetooth the panel stays on screen until it has sent the answer back.
      const ble = bleAnswerRef.current;
      if (!ble) setView({ k: "busy", label: t("Подготвям отговор…") });
      const { link, sdp } = await PeerLink.createAnswer(offer.sdp);
      mySdpRef.current = sdp;
      linkRef.current = link;
      const eph = createEphemeralKeyPair();
      ephemeralRef.current = eph;
      const answer = createInvitation("answer", sdp, identity.keyPair, eph.publicKey, {
        answersNonce: offer.nonce,
      });
      const payload = await encodeInvitation(answer);
      // Start waiting before the answer leaves, so the handshake can't be missed.
      const handshake = completeHandshake(link, identity.did, offer.publicKey, RESPONDER_TIMEOUT_MS);
      const demo = wsRef.current;
      if (ble) {
        bleAnswerRef.current = null;
        ble.resolve(payload);
      } else if (demo) {
        await demo.sendAnswer(toSignalingPayload(answer, payload));
        setView({ k: "busy", label: t("Свързвам…") });
      } else {
        pendingHexRef.current = await encodeInvitationHex(answer);
        await getProvider().sendAnswer(toSignalingPayload(answer, payload));
      }
      await handshake;
      const session = SecureSession.derive({
        role: "responder",
        myIdentity: identity.keyPair,
        myEphemeral: eph,
        peerIdentityPublicKey: offer.publicKey,
        peerEphemeralPublicKey: offer.ephemeralPublicKey,
      });
      afterHandshake(link, session, offer.publicKey);
    } catch (err) {
      const ble = bleAnswerRef.current;
      bleAnswerRef.current = null;
      ble?.reject(err);
      fail(err);
    } finally {
      busyRef.current = false;
    }
  }

  /** Bluetooth responder: hands the received offer to the normal flow and waits for its answer. */
  function onBleOffer(invitation: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      bleAnswerRef.current = { resolve, reject };
      void onOfferScanned(invitation);
    });
  }

  /* ---------- Safety confirmation ---------- */

  async function confirmMatch(peerPublicKey: Uint8Array, link: PeerLink, session: SecureSession) {
    const contact: Contact = {
      did: publicKeyToDidKey(peerPublicKey),
      publicKey: peerPublicKey,
      name: name.trim() || t("Контакт"),
      verified: true,
      verifiedAt: Date.now(),
      addedAt: Date.now(),
    };
    try {
      await saveContact(contact);
    } catch (err) {
      if (!(err instanceof ContactLimitError)) throw err;
      // The book filled up meanwhile (another tab, a group): nothing is saved, the link closes.
      link.close();
      linkRef.current = null;
      setFull(true);
      setError(t(CONTACT_LIMIT_MESSAGE));
      setView({ k: "choose" });
      return;
    }
    doneRef.current = true;
    onConnected({ contact, link, session });
  }

  function rejectMatch(link: PeerLink) {
    link.close();
    linkRef.current = null;
    setError(t("Кодовете не съвпаднаха. Връзката е прекратена и контактът не е запазен."));
    setView({ k: "choose" });
  }

  /* ---------- Rendering ---------- */

  if (view.k === "demo-wait") {
    return (
      <div className="screen">
        <h1>{t("Стая")}</h1>
        <p>{t("Другият човек въвежда този код в „Сканирай чужда покана“, режим Демо.")}</p>
        <PairingCodeShare code={view.code} />
        <p>
          {t(
            "Кажи този код на другия човек — по телефона или лично. Не го пращай през същия канал, през който е поканата.",
          )}
        </p>
        <p role="status" aria-live="polite">
          {view.matched ? t("Кодът съвпадна. Свързвам…") : t("Чакам другия човек…")}
        </p>
        <p className="net-hint">{view.net}</p>
        <button className="secondary" onClick={reset}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "ble") {
    return (
      <div className="screen">
        <h1>{t("Свързване по Bluetooth")}</h1>
        {error && <p role="alert">{error}</p>}
        <BlePairingPanel
          role={view.role}
          offer={view.offer}
          onAnswer={(invitation) => void onAnswerScanned(invitation)}
          onOffer={onBleOffer}
          onCancel={reset}
        />
      </div>
    );
  }

  if (view.k === "demo-join") {
    return <DemoCodeEntry onSubmit={(code) => void startDemoJoin(code)} onCancel={reset} />;
  }

  if (view.k === "choose") {
    return (
      <div className="screen">
        <h1>{expected ? t("Свързване с {name}", { name: expected.name }) : t("Нов контакт")}</h1>
        {full && !expected && (
          <p role="note" className="limit-note">
            {t(CONTACT_LIMIT_MESSAGE)}
          </p>
        )}
        <div role="group" aria-label={t("Начин на свързване")} className="call-actions">
          <button
            className={mode === "local" ? "" : "secondary"}
            aria-pressed={mode === "local"}
            onClick={() => {
              setSignalMode("local");
              setMode("local");
            }}
          >
            {t("Локален (QR)")}
          </button>
          <button
            className={mode === "demo" ? "" : "secondary"}
            aria-pressed={mode === "demo"}
            onClick={() => {
              setSignalMode("demo");
              setMode("demo");
            }}
          >
            {t("Демо (стая)")}
          </button>
          {bleSupported && (
            <button
              className={mode === "ble" ? "" : "secondary"}
              aria-pressed={mode === "ble"}
              onClick={() => {
                setSignalMode("ble");
                setMode("ble");
              }}
            >
              {t("Bluetooth")}
            </button>
          )}
        </div>
        <p>
          {mode === "ble"
            ? t("Поканата минава по Bluetooth между два телефона наблизо. Не се използва сървър. После сравнете думите за безопасност.")
            : mode === "demo"
            ? t(
                "Демо режимът използва сигналния сървър за стая с код. Сървърът вижда само номера на стаята и шифрован текст. Не съхранява нищо.",
              )
            : t("Локалният режим не прави мрежови заявки.")}
        </p>
        <p>
          {t(
            "Връзката е директна между двете устройства. Нищо не минава през сървър. Двамата трябва да са на едно място или да могат да си показват екраните.",
          )}
        </p>
        {error && <p role="alert">{error}</p>}
        <button onClick={startAsInitiator}>{t("Покажи моята покана")}</button>
        <button className="secondary" onClick={startAsResponder}>
          {t("Сканирай чужда покана")}
        </button>
        <button className="secondary" onClick={onCancel}>
          {t("Назад")}
        </button>
      </div>
    );
  }

  if (view.k === "busy") {
    return (
      <div className="screen">
        <p role="status" aria-live="polite">
          {view.label}
        </p>
        {view.cancellable && (
          <button className="secondary" onClick={reset}>
            {t("Отказ")}
          </button>
        )}
      </div>
    );
  }

  if (view.k === "offer-qr") {
    return (
      <div className="screen">
        <h1>{t("Покана")}</h1>
        <p>{t("Другият човек сканира този код. След това натисни „Сканирай отговора“.")}</p>
        <QrCode data={view.payload} size={360} />
        <p className="net-hint">{view.net}</p>
        <HexFallback hex={view.hex} />
        <p>{t("Не може да сканира? Използвай кратък код:")}</p>
        <ShortCodeShare payload={view.payload} />
        <button onClick={() => setView({ k: "scan-answer" })}>{t("Сканирай отговора")}</button>
        <button className="secondary" onClick={reset}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "scan-answer") {
    return (
      <div className="screen">
        <h1>{t("Сканирай отговора")}</h1>
        <p>{t("Сканирай QR кода, който се показва на другото устройство.")}</p>
        <QrScanner onDetected={onAnswerScanned} />
        <p>{t("Или въведи кратък код:")}</p>
        <ShortCodeEnter onPayload={onAnswerScanned} />
        <button className="secondary" onClick={reset}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "scan-offer") {
    return (
      <div className="screen">
        <h1>{t("Сканирай поканата")}</h1>
        <p>{t("Сканирай QR кода, който показва другият човек.")}</p>
        <QrScanner onDetected={onOfferScanned} />
        <p>{t("Или въведи кратък код:")}</p>
        <ShortCodeEnter onPayload={onOfferScanned} />
        <button className="secondary" onClick={reset}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "answer-qr") {
    return (
      <div className="screen">
        <h1>{t("Отговор")}</h1>
        <p>{t("Нека другият човек сканира този код. Чакаме връзката…")}</p>
        <QrCode data={view.payload} size={360} />
        <p className="net-hint">{view.net}</p>
        <HexFallback hex={view.hex} />
        <p>{t("Не може да сканира? Използвай кратък код:")}</p>
        <ShortCodeShare payload={view.payload} />
        <button className="secondary" onClick={reset}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  // view.k === "confirm"
  return (
    <div className="screen">
      <h1>{t("Потвърди контакта")}</h1>
      <p>
        {t("Сравнете тези думи с човека до вас (или по видео). Трябва да са")}{" "}
        <strong>{t("едни и същи")}</strong> {t("на двете устройства.")}
      </p>
      <p className="safety-code" aria-label={t("Код за сигурност")}>
        {formatSafetyCode(view.words)}
      </p>
      {!expected && (
        <label>
          {t("Име на контакта")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Например: Иван")}
            maxLength={40}
          />
        </label>
      )}
      <button onClick={() => void confirmMatch(view.peerPublicKey, view.link, view.session)}>
        {t("Думите съвпадат")}
      </button>
      <button className="secondary" onClick={() => rejectMatch(view.link)}>
        {t("Не съвпадат")}
      </button>
    </div>
  );
}

/** Demo: the other device's pairing code (room id and three words), typed in. */
function DemoCodeEntry({ onSubmit, onCancel }: { onSubmit: (code: PairingCode) => void; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="screen">
      <h1>{t("Въведи кода на стаята")}</h1>
      <PairingCodeEnter onSubmit={onSubmit} />
      <button className="secondary" onClick={onCancel}>
        {t("Отказ")}
      </button>
    </div>
  );
}
