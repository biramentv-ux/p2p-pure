import { useEffect, useState } from "react";
import { deleteContact, listContacts, type Contact } from "../../contacts/contacts";
import { Avatar, ConstellationArt } from "../components/Art";

interface ContactsScreenProps {
  onChat: (contact: Contact) => void;
  onNewContact: () => void;
}

export function ContactsScreen({ onChat, onNewContact }: ContactsScreenProps) {
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
    if (!window.confirm(`Да се изтрие ли „${c.name}“ от това устройство?`)) return;
    await deleteContact(c.did);
    setVersion((v) => v + 1);
  }

  return (
    <div className="screen">
      <h1>Контакти</h1>
      {error && <p role="alert">{error}</p>}
      {contacts === null && <p>Зареждане…</p>}
      {contacts?.length === 0 && (
        <div className="empty-block">
          <ConstellationArt />
          <p>Още няма потвърдени контакти. Добави първия с QR код, лично.</p>
        </div>
      )}
      <ul className="contact-list">
        {contacts?.map((c) => (
          <li key={c.did} className="contact">
            <Avatar seed={c.did} name={c.name} />
            <div className="contact-info">
              <strong>{c.name}</strong>
              {c.verified && <span className="badge">потвърден</span>}
              <span className="did-text" title={c.did}>
                {c.did.slice(0, 22)}…
              </span>
            </div>
            <div className="contact-actions">
              <button onClick={() => onChat(c)}>Чат</button>
              <button className="secondary" onClick={() => void onDelete(c)}>
                Изтрий
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button onClick={onNewContact}>Добави контакт</button>
    </div>
  );
}
