import { useEffect, useRef, useState } from "react";
import { copyWithAutoClear } from "../clipboard";
import { publicKeyToDidKey } from "../../identity/didKey";
import type { UnlockedIdentity } from "../../identity";
import { saveContact, type Contact } from "../../contacts/contacts";
import {
  assertKind,
  bytesEqual,
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  encodeInvitationHex,
  InvitationError,
  type Invitation,
} from "../../p2p/invitation";
import { PeerLink, CONNECT_TIMEOUT_MS } from "../../p2p/peer";
import { describeReachability, summarizeCandidates } from "../../p2p/network";
import { completeHandshake } from "../../p2p/session";
import { createEphemeralKeyPair, SecureSession, type EphemeralKeyPair } from "../../p2p/secureSession";
import { formatSafetyCode, safetyWords } from "../../p2p/safety";
import { useI18n } from "../../i18n";
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { ShortCodeEnter, ShortCodeShare } from "../components/ShortCode";

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
  | { k: "busy"; label: string }
  | { k: "offer-qr"; payload: string; hex: string; net: string }
  | { k: "scan-answer" }
  | { k: "scan-offer" }
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
  const busyRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    return () => {
      if (!doneRef.current) linkRef.current?.close();
    };
  }, []);

  function clearAll() {
    linkRef.current?.close();
    linkRef.current = null;
    offerRef.current = null;
    ephemeralRef.current = null;
    busyRef.current = false;
  }

  function fail(err: unknown) {
    clearAll();
    setError(err instanceof Error ? t(err.message) : t("Неизвестна грешка при свързване."));
    setView({ k: "choose" });
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
    const words = safetyWords(identity.keyPair.publicKey, peerPublicKey);
    setView({ k: "confirm", peerPublicKey, words, link, session });
  }

  /* ---------- Initiator: show offer, then scan answer ---------- */

  async function startAsInitiator() {
    setError(null);
    setView({ k: "busy", label: t("Подготвям покана…") });
    try {
      const { link, sdp } = await PeerLink.createOffer();
      linkRef.current = link;
      const eph = createEphemeralKeyPair();
      ephemeralRef.current = eph;
      const offer = createInvitation("offer", sdp, identity.keyPair, eph.publicKey);
      offerRef.current = offer;
      const payload = await encodeInvitation(offer);
      const hex = await encodeInvitationHex(offer);
      setView({ k: "offer-qr", payload, hex, net: t(describeReachability(summarizeCandidates(sdp))) });
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
      const answer = await decodeInvitation(text);
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
    setView({ k: "scan-offer" });
  }

  async function onOfferScanned(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const offer = await decodeInvitation(text);
      assertKind(offer, "offer");
      setView({ k: "busy", label: t("Подготвям отговор…") });
      const { link, sdp } = await PeerLink.createAnswer(offer.sdp);
      linkRef.current = link;
      const eph = createEphemeralKeyPair();
      ephemeralRef.current = eph;
      const answer = createInvitation("answer", sdp, identity.keyPair, eph.publicKey, {
        answersNonce: offer.nonce,
      });
      const payload = await encodeInvitation(answer);
      const hex = await encodeInvitationHex(answer);
      // Start waiting before showing the QR, so the handshake can't be missed.
      const handshake = completeHandshake(link, identity.did, offer.publicKey, RESPONDER_TIMEOUT_MS);
      setView({ k: "answer-qr", payload, hex, net: t(describeReachability(summarizeCandidates(sdp))) });
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
      fail(err);
    } finally {
      busyRef.current = false;
    }
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
    await saveContact(contact);
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

  if (view.k === "choose") {
    return (
      <div className="screen">
        <h1>{expected ? t("Свързване с {name}", { name: expected.name }) : t("Нов контакт")}</h1>
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
        <p>{view.label}</p>
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
