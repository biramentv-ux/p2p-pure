import { useEffect, useState } from "react";
import { deleteContact, listContacts, type Contact } from "../../contacts/contacts";
import { useI18n } from "../../i18n";
import { Avatar, ConstellationArt } from "../components/Art";

interface ContactsScreenProps {
  onChat: (contact: Contact) => void;
  onNewContact: () => void;
  onGroups: () => void;
}

export function ContactsScreen({ onChat, onNewContact, onGroups }: ContactsScreenProps) {
  const { t } = useI18n();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

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

  return (
    <div className="screen">
      <h1>{t("Контакти")}</h1>
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
              <span className="did-text" title={c.did}>
                {c.did.slice(0, 22)}…
              </span>
            </div>
            <div className="contact-actions">
              <button onClick={() => onChat(c)}>{t("Чат")}</button>
              <button className="secondary" onClick={() => void onDelete(c)}>
                {t("Изтрий")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button onClick={onNewContact}>{t("Добави контакт")}</button>
      <button className="secondary" onClick={onGroups}>
        {t("Групов чат")}
      </button>
    </div>
  );
}
