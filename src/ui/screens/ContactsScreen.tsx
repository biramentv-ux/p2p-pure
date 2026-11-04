import { useEffect, useState } from "react";
import { MAX_CONTACTS, deleteContact, listContacts, markContactVerified, type Contact } from "../../contacts/contacts";
import { formatSafetyCode, safetyWords } from "../../p2p/safety";
import { identityX25519Public } from "../../identity/x25519";
import { useI18n } from "../../i18n";
import { Avatar, ConstellationArt } from "../components/Art";

interface ContactsScreenProps {
  onChat: (contact: Contact) => void;
  onNewContact: () => void;
  onGroups: () => void;
  /** Flow (a): introduce two of my contacts to each other. */
  onIntroduce?: () => void;
  /** Flow (b): ask this contact to introduce me to someone. */
  onAskIntro?: (contact: Contact) => void;
  /** The introductions screen (incoming invitations and progress). */
  onIntroductions?: () => void;
  /** Invitations and requests waiting for an answer. */
  introPending?: number;
  /** For the safety code of introduced, not yet verified contacts. */
  myPublicKey?: Uint8Array;
}

export function ContactsScreen({
  onChat,
  onNewContact,
  onGroups,
  onIntroduce,
  onAskIntro,
  onIntroductions,
  introPending = 0,
  myPublicKey,
}: ContactsScreenProps) {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  /** The introduced contact whose safety code is open. */
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listContacts()
      .then((list) => {
        if (alive) setContacts(list);
      })
      .catch(() => {
        if (alive) setError("Контактите не можаха да се заредят.");
      });
    return () => {
      alive = false;
    };
  }, [version]);

  async function onDelete(c: Contact) {
    if (!window.confirm(t("Да се изтрие ли „{name}“ от това устройство?", { name: c.name }))) return;
    await deleteContact(c.did);
    setVersion((v) => v + 1);
  }

  async function onCodeMatches(c: Contact) {
    try {
      await markContactVerified(c.did);
      setChecking(null);
      setVersion((v) => v + 1);
    } catch {
      setError("Контактът не можа да се запише.");
    }
  }

  return (
    <div className="screen">
      <h1>{t("Контакти")}</h1>
      {contacts && (
        <p className={contacts.length >= MAX_CONTACTS ? "contact-count full" : "contact-count"} aria-live="polite">
          {t("{n} от {max} контакта", { n: contacts.length, max: MAX_CONTACTS })}
        </p>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {contacts === null && (
        <ul className="skeleton-list" aria-busy="true" aria-label={t("Зареждане на контактите")}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="skeleton-row" />
          ))}
        </ul>
      )}
      {contacts?.length === 0 && (
        <div className="empty-block">
          <ConstellationArt />
          <p>{t("Още няма потвърдени контакти. Добави първия с QR код, лично.")}</p>
        </div>
      )}
      <ul className="contact-list">
        {contacts?.map((c) => (
          <li key={c.did} className="contact">
            <Avatar seed={c.did} name={c.name} />
            <div className="contact-info">
              <strong>{c.name}</strong>
              {c.verified && <span className="badge">{t("потвърден")}</span>}
              {c.introducedBy && (
                <span className="badge" title={c.introducedBy.did}>
                  {t("Запознати чрез {c}", { c: c.introducedBy.name })}
                </span>
              )}
              {!c.verified && <span>{t("непотвърден: сравнете кода за сигурност")}</span>}
              <span className="did-text" title={c.did}>
                {c.did.slice(0, 22)}…
              </span>
            </div>
            <div className="contact-actions">
              <button onClick={() => onChat(c)}>{t("Чат")}</button>
              {!c.verified && myPublicKey && (
                <button
                  className="secondary"
                  aria-expanded={checking === c.did}
                  onClick={() => setChecking(checking === c.did ? null : c.did)}
                >
                  {t("Сравни кода")}
                </button>
              )}
              {onAskIntro && (
                <button className="secondary" onClick={() => onAskIntro(c)}>
                  {t("Помоли за запознанство")}
                </button>
              )}
              <button className="secondary" onClick={() => void onDelete(c)}>
                {t("Изтрий")}
              </button>
            </div>
            {!c.verified && myPublicKey && checking === c.did && (
              <div role="group" aria-label={t("Код за сигурност")} className="call-panel">
                <p>
                  {c.introducedBy
                    ? t("{c} ви запозна, но името е избрано от {c}. Сравнете думите с {name} лично или по видео.", {
                        c: c.introducedBy.name,
                        name: c.name,
                      })
                    : t("Сравнете думите с {name} лично или по видео.", { name: c.name })}
                </p>
                <p className="safety-code" aria-label={t("Код за сигурност")}>
                  {formatSafetyCode(safetyWords(identityX25519Public(myPublicKey), identityX25519Public(c.publicKey)))}
                </p>
                <div className="call-actions">
                  <button onClick={() => void onCodeMatches(c)}>{t("Думите съвпадат")}</button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setChecking(null);
                      setError("Кодовете не съвпаднаха. Контактът остава непотвърден: не му се доверявай.");
                    }}
                  >
                    {t("Не съвпадат")}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button onClick={onNewContact}>{t("Добави контакт")}</button>
      <button className="secondary" onClick={onGroups}>
        {t("Групов чат")}
      </button>
      {onIntroduce && (
        <button className="secondary" onClick={onIntroduce}>
          {t("Запознай двама")}
        </button>
      )}
      {onIntroductions && (
        <button className="secondary" onClick={onIntroductions}>
          {introPending > 0 ? t("Запознанства ({n})", { n: introPending }) : t("Запознанства")}
        </button>
      )}
    </div>
  );
}
