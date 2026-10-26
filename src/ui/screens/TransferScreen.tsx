/**
 * One-time move of the identity between devices (docs/MULTIDEVICE.md). Two screens:
 *   TransferSendScreen     old device, identity unlocked: shows the offer, scans the answer,
 *                          compares the words, sends, then offers to wipe this device.
 *   TransferReceiveScreen  new device, no identity yet: scans the offer, shows the answer,
 *                          compares the words, stores the identity with its OWN unlock method.
 */
import { useEffect, useRef, useState } from "react";
import { getUnlockMethod, IdentityError, isWebAuthnSupported } from "../../identity";
import type { UnlockedIdentity } from "../../identity";
import { unlockSeed } from "../../identity/seedTransfer";
import { listContacts } from "../../contacts/contacts";
import { copyWithAutoClear } from "../clipboard";
import { useI18n } from "../../i18n";
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { CONNECT_TIMEOUT_MS, type PeerLink } from "../../p2p/peer";
import { TransferEndpoint, type TransferState } from "../../transfer/endpoint";
import { TransferError } from "../../transfer/packet";
import { acceptAnswerText, answerOffer, beginSend, runEndpoint, type SenderOffer } from "../../transfer/link";
import { stopWritersAndWipe, type BackgroundWriter } from "../../transfer/wipe";
import { completeReceive, newReceiveProgress } from "../../transfer/receive";

const MIN_PASSWORD_LENGTH = 12;
/** The receiver waits longer: the sender has to scan its answer first. */
const RECEIVER_WAIT_MS = 5 * 60_000;

function Words({ words }: { words: string[] }) {
  return (
    <ol className="mnemonic-grid" aria-label="SAS">
      {words.map((w, i) => (
        <li key={i}>{w}</li>
      ))}
    </ol>
  );
}

function HexFallback({ hex }: { hex: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <details>
      <summary>{t("Няма камера на другото устройство?")}</summary>
      <p>{t("Копирай кода само по доверен път. Подмяна на кода е атака: сравни думите накрая.")}</p>
      <textarea readOnly rows={4} value={hex} aria-label={t("Код като hex")} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="secondary"
        onClick={() =>
          void copyWithAutoClear(hex).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? t("Копирано") : t("Копирай кода")}
      </button>
    </details>
  );
}

function explain(err: unknown, t: (s: string) => string): string {
  if (err instanceof TransferError || err instanceof IdentityError || err instanceof Error) return t(err.message);
  return t("Неизвестна грешка при прехвърлянето.");
}

/* ------------------------------------------------------------------ */
/* Old device                                                          */
/* ------------------------------------------------------------------ */

type SendView =
  | { k: "intro" }
  | { k: "busy"; label: string }
  | { k: "offer"; text: string; hex: string }
  | { k: "scan" }
  | { k: "protocol" }
  | { k: "wiped-ask" };

interface SendProps {
  identity: UnlockedIdentity;
  /** Called after this device has been wiped: the app returns to the "no identity" state. */
  onMoved: () => void;
  onCancel: () => void;
  /**
   * Hands over everything that writes to the database in the background (the group session),
   * so it is stopped and drained before the wipe. The caller must forget these objects.
   */
  takeWriters: () => Array<BackgroundWriter | null | undefined>;
}

export function TransferSendScreen({ identity, onMoved, onCancel, takeWriters }: SendProps) {
  const { t } = useI18n();
  const [view, setView] = useState<SendView>({ k: "intro" });
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<TransferState>("connecting");
  const [confirmWipe, setConfirmWipe] = useState(false);
  const seedRef = useRef<Uint8Array | null>(null);
  const offerRef = useRef<SenderOffer | null>(null);
  const endpointRef = useRef<TransferEndpoint | null>(null);
  const busyRef = useRef(false);
  const [words, setWords] = useState<string[]>([]);

  useEffect(() => {
    getUnlockMethod()
      .then((m) => setNeedsPassword(m !== "webauthn-prf"))
      .catch(() => setNeedsPassword(true));
  }, []);

  function cleanup() {
    seedRef.current?.fill(0);
    seedRef.current = null;
    endpointRef.current?.abort();
    endpointRef.current = null;
    offerRef.current?.link.close();
    offerRef.current = null;
  }
  useEffect(
    () => () => {
      seedRef.current?.fill(0);
      offerRef.current?.link.close();
    },
    [],
  );

  function fail(err: unknown) {
    cleanup();
    busyRef.current = false;
    setError(explain(err, t));
    setView({ k: "intro" });
  }

  async function start() {
    setError(null);
    setView({ k: "busy", label: t("Потвърждавам самоличността…") });
    try {
      // Re-authentication: the passkey prompt or the password, even though the app is unlocked.
      seedRef.current = await unlockSeed(needsPassword ? password : undefined);
      setPassword("");
      setView({ k: "busy", label: t("Подготвям код…") });
      const offer = await beginSend();
      offerRef.current = offer;
      setView({ k: "offer", text: offer.text, hex: offer.hex });
    } catch (err) {
      if (err instanceof IdentityError && err.code === "DECRYPTION_FAILED") {
        fail(new Error("Грешна парола."));
      } else {
        fail(err);
      }
    }
  }

  async function onAnswer(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    const offer = offerRef.current;
    try {
      if (!offer || !seedRef.current) throw new TransferError("Няма активно прехвърляне.", "BAD_STATE");
      setView({ k: "busy", label: t("Свързвам…") });
      const keys = await acceptAnswerText(offer, text);
      const seed = seedRef.current;
      const endpoint = await runEndpoint(
        offer.link,
        {
          keys,
          ownDid: identity.did,
          getBundle: async () => ({ seed, contacts: await listContacts() }),
        },
        CONNECT_TIMEOUT_MS,
      );
      endpointRef.current = endpoint;
      setWords(endpoint.words);
      const onState = (s: TransferState) => {
        setState(s);
        if (s === "stored") {
          seedRef.current?.fill(0);
          seedRef.current = null;
          setView({ k: "wiped-ask" });
        } else if (s === "failed" || s === "aborted") {
          const e = endpoint.error;
          cleanup();
          busyRef.current = false;
          setError(e ? t(e.message) : t("Прехвърлянето е прекратено."));
          setView({ k: "intro" });
        }
      };
      endpoint.onState(onState);
      onState(endpoint.state);
      setView({ k: "protocol" });
    } catch (err) {
      fail(err);
    }
  }

  async function wipe() {
    try {
      await stopWritersAndWipe(takeWriters());
      onMoved();
    } catch (err) {
      setError(explain(err, t));
    }
  }

  if (view.k === "busy") {
    return (
      <div className="screen">
        <p>{view.label}</p>
      </div>
    );
  }

  if (view.k === "offer") {
    return (
      <div className="screen">
        <h1>{t("1. Покажи кода на новото устройство")}</h1>
        <p>{t("На новото устройство избери „Имам друго устройство“ и сканирай този код. Кодът важи 10 минути и само веднъж.")}</p>
        <QrCode data={view.text} size={320} label={t("QR код за прехвърляне")} />
        <HexFallback hex={view.hex} />
        <button onClick={() => setView({ k: "scan" })}>{t("Сканирай отговора на новото устройство")}</button>
        <button className="secondary" onClick={() => (cleanup(), onCancel())}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "scan") {
    return (
      <div className="screen">
        <h1>{t("2. Сканирай отговора")}</h1>
        <p>{t("Новото устройство показва втори код. Насочи камерата към него.")}</p>
        <QrScanner onDetected={(text) => void onAnswer(text)} />
        <button className="secondary" onClick={() => (cleanup(), onCancel())}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "protocol") {
    const ep = endpointRef.current;
    return (
      <div className="screen">
        <h1>{t("3. Сравни думите")}</h1>
        {(state === "compare" || state === "waiting-peer") && (
          <>
            <p>{t("Същите 6 думи трябва да се виждат на новото устройство. Ако не са същите, спри.")}</p>
            <Words words={words} />
            {state === "compare" ? (
              <>
                <button onClick={() => void ep?.confirmSas(true)}>{t("Думите съвпадат")}</button>
                <button className="secondary" onClick={() => void ep?.confirmSas(false)}>
                  {t("Не съвпадат")}
                </button>
              </>
            ) : (
              <p>{t("Чакам потвърждение от новото устройство…")}</p>
            )}
          </>
        )}
        {state === "connecting" && <p>{t("Свързвам…")}</p>}
        {state === "sending" && <p>{t("Изпращам. Не затваряй приложението…")}</p>}
        <button className="secondary" onClick={() => ep?.abort()}>
          {t("Прекрати")}
        </button>
      </div>
    );
  }

  if (view.k === "wiped-ask") {
    return (
      <div className="screen">
        <h1>{t("Прехвърлено")}</h1>
        <p>{t("Новото устройство запази идентичността. За да остане само едно място с ключа, изтрий данните от това устройство.")}</p>
        <p>{t("Ще се изтрият идентичността, контактите и историята на чатовете тук. Историята и групите не се прехвърлят. С 12-те думи можеш да възстановиш идентичността.")}</p>
        <label className="confirm-row">
          <input type="checkbox" checked={confirmWipe} onChange={(e) => setConfirmWipe(e.target.checked)} />
          {t("Разбирам, изтрий това устройство")}
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={!confirmWipe} onClick={() => void wipe()}>
          {t("Изтрий от това устройство")}
        </button>
        <button className="secondary" onClick={onCancel}>
          {t("По-късно (идентичността остава на двете устройства)")}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <h1>{t("Премести идентичността на ново устройство")}</h1>
      <p>{t("Прехвърлянето е директно между двете устройства, без сървър. Не се копират сесии: контактите ти се свързват наново с новото устройство.")}</p>
      <p>{t("Това е преместване, не синхронизация: след потвърждение тук всичко се изтрива.")}</p>
      {needsPassword && (
        <label>
          {t("Парола")}
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <button disabled={needsPassword && password.length === 0} onClick={() => void start()}>
        {t("Започни")}
      </button>
      <button className="secondary" onClick={onCancel}>
        {t("Отказ")}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* New device                                                          */
/* ------------------------------------------------------------------ */

type RecvView =
  | { k: "intro" }
  | { k: "scan" }
  | { k: "busy"; label: string }
  | { k: "answer"; text: string; hex: string }
  | { k: "protocol" }
  | { k: "unlock" }
  /** Stored here, but the old device did not get the confirmation. */
  | { k: "unacked"; identity: UnlockedIdentity };

interface RecvProps {
  onDone: (identity: UnlockedIdentity) => void;
  onCancel: () => void;
}

export function TransferReceiveScreen({ onDone, onCancel }: RecvProps) {
  const { t } = useI18n();
  const [view, setView] = useState<RecvView>({ k: "intro" });
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<TransferState>("connecting");
  const [words, setWords] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [storing, setStoring] = useState(false);
  const linkRef = useRef<PeerLink | null>(null);
  const endpointRef = useRef<TransferEndpoint | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef(false);
  const progressRef = useRef(newReceiveProgress());
  const webAuthnOk = isWebAuthnSupported();

  useEffect(
    () => () => {
      if (!doneRef.current) linkRef.current?.close();
    },
    [],
  );

  function fail(err: unknown) {
    endpointRef.current?.abort();
    endpointRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    busyRef.current = false;
    setError(explain(err, t));
    setView({ k: "intro" });
  }

  async function onOffer(text: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setView({ k: "busy", label: t("Подготвям отговор…") });
    try {
      const a = await answerOffer(text);
      linkRef.current = a.link;
      setView({ k: "answer", text: a.text, hex: a.hex });
      const endpoint = await runEndpoint(a.link, { keys: a.keys }, RECEIVER_WAIT_MS);
      endpointRef.current = endpoint;
      setWords(endpoint.words);
      const onState = (s: TransferState) => {
        setState(s);
        if (s === "received") setView({ k: "unlock" });
        else if (s === "failed" || s === "aborted") {
          const stored = progressRef.current.identity;
          if (stored) {
            // Already written here: never send the user back to the start with an identity on disk.
            setView({ k: "unacked", identity: stored });
            return;
          }
          const e = endpoint.error;
          endpointRef.current = null;
          linkRef.current?.close();
          linkRef.current = null;
          busyRef.current = false;
          setError(e ? t(e.message) : t("Прехвърлянето е прекратено."));
          setView({ k: "intro" });
        }
      };
      endpoint.onState(onState);
      if (endpoint.state === "received") onState(endpoint.state);
      else setState(endpoint.state);
      setView((v) => (v.k === "unlock" ? v : { k: "protocol" }));
    } catch (err) {
      fail(err);
    }
  }

  /** Stores the received identity with this device's own unlock method, then tells the sender. */
  async function store(usePassword: boolean) {
    const endpoint = endpointRef.current;
    const bundle = endpoint?.bundle;
    if (!endpoint || !bundle || storing) return;
    if (usePassword) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setError(t("Паролата трябва да е поне {n} символа.", { n: MIN_PASSWORD_LENGTH }));
        return;
      }
      if (password !== confirmPw) {
        setError(t("Паролите не съвпадат."));
        return;
      }
    }
    setStoring(true);
    setError(null);
    try {
      const result = await completeReceive(
        bundle,
        progressRef.current,
        (did) => endpoint.reportStored(did),
        usePassword ? password : undefined,
        usePassword ? { skipPasskey: true } : {},
      );
      doneRef.current = true;
      if (result.acknowledged) onDone(result.identity);
      else setView({ k: "unacked", identity: result.identity });
    } catch (err) {
      setStoring(false);
      if (progressRef.current.identity) {
        // The identity is stored; only the contacts failed. A retry writes them again (idempotent).
        setError(explain(err, t));
        return;
      }
      if (err instanceof IdentityError && err.code === "PRF_UNSUPPORTED") {
        setError(t("Този passkey не поддържа PRF. Задай парола за това устройство."));
        return;
      }
      if (err instanceof IdentityError && err.code === "ALREADY_EXISTS") {
        await endpoint.reportFailed();
        fail(err);
        return;
      }
      // Passkey dialog closed or storing failed: the data is still here, the user may retry.
      setError(explain(err, t));
    }
  }

  if (view.k === "unacked") {
    const identity = view.identity;
    return (
      <div className="screen">
        <h1>{t("Идентичността е запазена тук")}</h1>
        <p role="alert">
          {t("Старото устройство не получи потвърждение, затова няма да предложи изтриване. Не го изтривай, докато не провериш, че новото устройство работи; после го изтрий ръчно.")}
        </p>
        <button
          onClick={() => {
            doneRef.current = true;
            linkRef.current?.close();
            onDone(identity);
          }}
        >
          {t("Продължи")}
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

  if (view.k === "scan") {
    return (
      <div className="screen">
        <h1>{t("1. Сканирай кода от старото устройство")}</h1>
        <QrScanner onDetected={(text) => void onOffer(text)} />
        <button className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "answer") {
    return (
      <div className="screen">
        <h1>{t("2. Покажи този код на старото устройство")}</h1>
        <p>{t("Старото устройство го сканира. После ще сравните 6 думи.")}</p>
        <QrCode data={view.text} size={320} label={t("QR код за отговор")} />
        <HexFallback hex={view.hex} />
        <button className="secondary" onClick={() => fail(new Error("Прекратено."))}>
          {t("Отказ")}
        </button>
      </div>
    );
  }

  if (view.k === "protocol") {
    const ep = endpointRef.current;
    return (
      <div className="screen">
        <h1>{t("3. Сравни думите")}</h1>
        {(state === "compare" || state === "waiting-bundle") && (
          <>
            <p>{t("Същите 6 думи трябва да се виждат на старото устройство. Ако не са същите, спри.")}</p>
            <Words words={words} />
            {state === "compare" ? (
              <>
                <button onClick={() => void ep?.confirmSas(true)}>{t("Думите съвпадат")}</button>
                <button className="secondary" onClick={() => void ep?.confirmSas(false)}>
                  {t("Не съвпадат")}
                </button>
              </>
            ) : (
              <p>{t("Чакам старото устройство…")}</p>
            )}
          </>
        )}
        {state === "connecting" && <p>{t("Свързвам…")}</p>}
        <button className="secondary" onClick={() => ep?.abort()}>
          {t("Прекрати")}
        </button>
      </div>
    );
  }

  if (view.k === "unlock") {
    return (
      <div className="screen">
        <h1>{t("Защити идентичността на това устройство")}</h1>
        <p>{t("Идентичността е получена. Избери как да се отключва на това устройство. Паролата не се прехвърля от старото устройство.")}</p>
        {webAuthnOk && (
          <button disabled={storing} onClick={() => void store(false)}>
            {t("Използвай passkey")}
          </button>
        )}
        <label>
          {t("Парола")}
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          {t("Повтори паролата")}
          <input type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        </label>
        {error && <p role="alert">{error}</p>}
        <button className={webAuthnOk ? "secondary" : ""} disabled={storing} onClick={() => void store(true)}>
          {t("Запази с парола")}
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <h1>{t("Имам друго устройство")}</h1>
      <p>{t("Вземи старото устройство, отключено. На него отвори Идентичност и избери „Премести на ново устройство“.")}</p>
      {error && <p role="alert">{error}</p>}
      <button onClick={() => setView({ k: "scan" })}>{t("Сканирай кода")}</button>
      <button className="secondary" onClick={onCancel}>
        {t("Назад")}
      </button>
    </div>
  );
}
