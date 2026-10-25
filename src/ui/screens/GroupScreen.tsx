import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listContacts, type Contact } from "../../contacts/contacts";
import { MAX_GROUP_MEMBERS } from "../../group/groupModel";
import type { GroupSession } from "../../group/groupSession";
import { CIPHER_SUITES, suiteLabel, type CipherSuite } from "../../p2p/cipherSuite";
import { useI18n } from "../../i18n";

interface GroupScreenProps {
  /** Null until the user creates or joins a group. */
  session: GroupSession | null;
  onCreate: (name: string, creatorName: string) => void;
  /** Connects this device to a contact over a fresh pairwise link (the usual connect flow). */
  onLink: (contact: Contact) => void;
  onLeave: () => void;
}

function useGroupView(session: GroupSession | null) {
  const subscribe = (fn: () => void) => (session ? session.subscribe(fn) : () => undefined);
  const getSnapshot = () => session?.snapshot ?? null;
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function GroupScreen({ session, onCreate, onLink, onLeave }: GroupScreenProps) {
  const { t } = useI18n();
  const view = useGroupView(session);
  const [name, setName] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let alive = true;
    void listContacts().then((list) => alive && setContacts(list.filter((c) => c.verified)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [view?.messages.length]);

  // Not in a group yet: create one, or connect to the person who invited you.
  if (!session || !view || (!view.joined && !view.pending)) {
    return (
      <section className="screen" aria-labelledby="group-title">
        <h1 id="group-title">{t("Групов чат")}</h1>
        <p>{t("Групата е до {n} участника. Всеки участник е свързан с всеки другия, без сървър за съобщенията.", { n: MAX_GROUP_MEMBERS })}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCreate(name, creatorName);
          }}
        >
          <label>
            {t("Име на групата")}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <label>
            {t("Вашето име в групата")}
            <input value={creatorName} onChange={(e) => setCreatorName(e.target.value)} maxLength={40} required />
          </label>
          <button type="submit" disabled={name.trim() === "" || creatorName.trim() === ""}>
            {t("Създай групата")}
          </button>
        </form>
        <h2>{t("Имате покана?")}</h2>
        <p>{t("Свържете се с човека, който ви покани, и после ще бъдете допуснати.")}</p>
        <ul>
          {contacts.map((c) => (
            <li key={c.did}>
              {c.name}{" "}
              <button className="secondary" onClick={() => onLink(c)}>
                {t("Свържи се")}
              </button>
            </li>
          ))}
        </ul>
        <button className="secondary" onClick={onLeave}>
          {t("Назад")}
        </button>
      </section>
    );
  }

  const state = view.state;
  const members = state?.members ?? [];
  const others = members.filter((m) => m.did !== session.me);
  const invitable = contacts.filter((c) => !members.some((m) => m.did === c.did));
  const suiteChoices = CIPHER_SUITES.filter((s: CipherSuite) => s !== state?.suite);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="screen" aria-labelledby="group-title">
      <h1 id="group-title">{state?.name ?? t("Групов чат")}</h1>
      <p role="status">
        {view.joined
          ? t("Участници: {n} от {max}", { n: members.length, max: MAX_GROUP_MEMBERS })
          : view.pending
            ? t("Чакате допускане. Свържете се с всички участници.")
            : t("Още не сте в групата.")}
      </p>

      {view.removed && <p className="chat-notice" role="alert">{t("Бяхте махнат от групата.")}</p>}
      {view.notices.length > 0 && (
        <ul className="chat-notice" aria-live="polite">
          {view.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <h2>{t("Участници")}</h2>
      <ul>
        {members.map((m) => {
          const linked = m.did === session.me || view.linked.includes(m.did);
          return (
            <li key={m.did}>
              <strong>{m.name}</strong>{" "}
              {m.did === state?.creatorDid && <small>({t("админ")})</small>}{" "}
              <small>{m.did === session.me ? t("това устройство") : linked ? t("свързан") : t("няма връзка")}</small>{" "}
              {m.did !== session.me && !linked && (
                <button
                  className="secondary"
                  onClick={() => {
                    const c = contacts.find((x) => x.did === m.did);
                    if (c) onLink(c);
                  }}
                >
                  {t("Свържи се")}
                </button>
              )}
              {view.isAdmin && m.did !== session.me && (
                <button className="secondary" disabled={busy} onClick={() => void run(() => session.remove(m.did))}>
                  {t("Махни")}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {view.isAdmin && view.joined && (
        <>
          <h2>{t("Покани")}</h2>
          {members.length >= MAX_GROUP_MEMBERS && <p>{t("Групата е пълна.")}</p>}
          <ul>
            {invitable.map((c) => (
              <li key={c.did}>
                {c.name}{" "}
                {view.linked.includes(c.did) ? (
                  <button
                    disabled={busy || members.length >= MAX_GROUP_MEMBERS}
                    onClick={() => void run(() => session.invite(c.did, c.name))}
                  >
                    {t("Покани")}
                  </button>
                ) : (
                  <button className="secondary" onClick={() => onLink(c)}>
                    {t("Свържи се")}
                  </button>
                )}
              </li>
            ))}
          </ul>

          <h2>{t("Криптографски метод")}</h2>
          <p>
            {t("Текущ метод")}: {state ? suiteLabel(state.suite) : ""}
          </p>
          <div className="call-actions">
            {suiteChoices.map((suite) => (
              <button
                key={suite}
                className="secondary"
                disabled={busy || others.length === 0}
                onClick={() => void run(() => session.openSuite(suite))}
              >
                {t("Предложи {suite}", { suite: suiteLabel(suite) })}
              </button>
            ))}
          </div>
        </>
      )}

      {view.suiteRequest && (
        <div role="group" aria-label={t("Предложение за смяна")} className="call-panel">
          <p>{t("Създателят предлага {suite}.", { suite: suiteLabel(view.suiteRequest) })}</p>
          <div className="call-actions">
            <button disabled={busy} onClick={() => void run(() => session.answerSuite(true))}>
              {t("Приеми")}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void run(() => session.answerSuite(false))}>
              {t("Откажи")}
            </button>
          </div>
        </div>
      )}

      {view.joined && (
        <>
          <h2>{t("Съобщения")}</h2>
          <ul ref={logRef} aria-label={t("Съобщения")} style={{ maxHeight: "40vh", overflowY: "auto", listStyle: "none", padding: 0 }}>
            {view.messages.map((m) => (
              <li key={m.id}>
                <strong>{m.mine ? t("Вие") : (members.find((x) => x.did === m.from)?.name ?? t("Участник"))}:</strong>{" "}
                {m.text}
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text) return;
              setDraft("");
              void run(() => session.sendText(text));
            }}
          >
            <label>
              {t("Съобщение")}
              <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={4000} />
            </label>
            <button type="submit" disabled={busy || draft.trim() === ""}>
              {t("Изпрати")}
            </button>
          </form>
        </>
      )}

      <button className="secondary" onClick={onLeave}>
        {t("Назад")}
      </button>
    </section>
  );
}
