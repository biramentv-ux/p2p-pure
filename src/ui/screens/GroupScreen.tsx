import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { listContacts, saveContact, type Contact } from "../../contacts/contacts";
import { MAX_GROUP_MEMBERS } from "../../group/groupModel";
import { MAX_GROUP_PHOTO_BYTES, type GroupSession } from "../../group/groupSession";
import { MAX_GROUP_FILE_BYTES } from "../../p2p/fileTransfer";
import { FileBubble, TransferList } from "../components/FileBubble";
import { GifPicker } from "../components/GifPicker";
import { GIPHY_KEY } from "../giphy";
import { CIPHER_SUITES, suiteLabel, type CipherSuite } from "../../p2p/cipherSuite";
import { formatSafetyCode, safetyWords } from "../../p2p/safety";
import { identityX25519Public } from "../../identity/x25519";
import { useI18n } from "../../i18n";
import { prepareImage } from "../image";

/** The group photo is a small avatar: it is sent to every member. */
const GROUP_PHOTO_SIDE = 512;

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
  const [error, setError] = useState<string | null>(null);
  /** The member whose safety code is open for comparing. */
  const [checking, setChecking] = useState<string | null>(null);
  const logRef = useRef<HTMLUListElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [showGif, setShowGif] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

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
        {view?.removed && (
          <p className="chat-notice" role="alert">
            {t("Бяхте махнат от групата. Ключовете и историята ѝ са изтрити от това устройство.")}
          </p>
        )}
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

  const group = session;
  const state = view.state;
  const members = state?.members ?? [];
  const others = members.filter((m) => m.did !== group.me);
  const invitable = contacts.filter((c) => !members.some((m) => m.did === c.did));
  const suiteChoices = CIPHER_SUITES.filter((s: CipherSuite) => s !== state?.suite);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(t(err instanceof Error ? err.message : "Действието не успя."));
    } finally {
      setBusy(false);
    }
  }

  async function onPickPhoto(file: File | undefined) {
    if (!file) return;
    await run(async () => {
      const bytes = await prepareImage(file, { maxBytes: MAX_GROUP_PHOTO_BYTES, maxSide: GROUP_PHOTO_SIDE });
      await group.setPhoto(bytes);
    });
  }

  /**
   * Sends a file, photo, video or GIF to every member linked right now. It does not block the
   * screen: each member accepts on their own, and the list below shows the progress.
   */
  async function sendFile(blob: Blob, fileName: string) {
    setError(null);
    if (blob.size > MAX_GROUP_FILE_BYTES) {
      setError(t("Файлът е по-голям от {mb} MB.", { mb: Math.round(MAX_GROUP_FILE_BYTES / 1048576) }));
      return;
    }
    setSending(fileName);
    try {
      const sent = group.sendFile(blob, fileName);
      // Hashing ends quickly; from then on the transfer list shows each member.
      setTimeout(() => setSending(null), 1500);
      const r = await sent;
      if (r.delivered < r.offered) {
        setError(t("Файлът стигна до {done} от {all} участници.", { done: r.delivered, all: r.offered }));
      }
    } catch (err) {
      setError(t(err instanceof Error ? err.message : "Файлът не беше изпратен."));
    } finally {
      setSending(null);
    }
  }

  /** The user compared the words with this member and they matched: saved as a verified contact. */
  async function confirmCode(did: string, memberName: string) {
    const contact = group.contactOf(did);
    if (!contact) return;
    await run(async () => {
      await saveContact({ ...contact, name: contact.name || memberName, verified: true, verifiedAt: Date.now() });
      group.markVerified(did);
      setChecking(null);
    });
  }

  function rejectCode(did: string) {
    group.drop(did);
    setChecking(null);
    setError(t("Кодовете не съвпаднаха. Връзката с този участник е прекратена."));
  }

  return (
    <section className="screen" aria-labelledby="group-title">
      {view.photo && (
        <img src={view.photo} alt={t("Снимка на групата")} width={96} height={96} style={{ borderRadius: "50%", objectFit: "cover" }} />
      )}
      <h1 id="group-title">{state?.name ?? t("Групов чат")}</h1>
      <p role="status">
        {view.joined
          ? t("Участници: {n} от {max}", { n: members.length, max: MAX_GROUP_MEMBERS })
          : view.pending
            ? t("Чакате допускане. Връзките с участниците се правят автоматично през създателя.")
            : t("Още не сте в групата.")}
      </p>
      {view.photoProgress && (
        <p className="chat-notice" role="status">
          {t("Получавам снимката на групата: {percent}%", {
            percent: Math.min(100, Math.round((view.photoProgress.done / Math.max(1, view.photoProgress.total)) * 100)),
          })}
        </p>
      )}

      {view.removed && <p className="chat-notice" role="alert">{t("Бяхте махнат от групата.")}</p>}
      {error && <p role="alert">{error}</p>}
      {view.notices.length > 0 && (
        <ul className="chat-notice" aria-live="polite">
          {view.notices.map((n, i) => (
            <li key={i}>{t(n.text, n.vars)}</li>
          ))}
        </ul>
      )}

      <h2>{t("Участници")}</h2>
      <ul>
        {members.map((m) => {
          const linked = m.did === group.me || view.linked.includes(m.did);
          const unverified = view.unverified.includes(m.did);
          const contact = group.contactOf(m.did);
          return (
            <li key={m.did}>
              <strong>{m.name}</strong>{" "}
              {m.did === state?.creatorDid && <small>({t("админ")})</small>}{" "}
              <small>
                {m.did === group.me
                  ? t("това устройство")
                  : linked
                    ? t("свързан")
                    : view.linking.includes(m.did)
                      ? t("свързва се…")
                      : t("няма връзка")}
              </small>{" "}
              {unverified && <small>({t("кодът не е сравнен")})</small>}{" "}
              {m.did !== group.me && !linked && (
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
              {unverified && contact && checking !== m.did && (
                <button className="secondary" onClick={() => setChecking(m.did)}>
                  {t("Сравни кода")}
                </button>
              )}
              {view.isAdmin && m.did !== group.me && (
                <button className="secondary" disabled={busy} onClick={() => void run(() => group.remove(m.did))}>
                  {t("Махни")}
                </button>
              )}
              {unverified && contact && checking === m.did && (
                <div role="group" aria-label={t("Код за сигурност")} className="call-panel">
                  <p>
                    {t("Връзката с {name} е направена през създателя. Сравнете думите с {name} лично или по видео.", {
                      name: m.name,
                    })}
                  </p>
                  <p className="safety-code" aria-label={t("Код за сигурност")}>
                    {formatSafetyCode(
                      safetyWords(identityX25519Public(group.myPublicKey), identityX25519Public(contact.publicKey)),
                    )}
                  </p>
                  <div className="call-actions">
                    <button disabled={busy} onClick={() => void confirmCode(m.did, m.name)}>
                      {t("Думите съвпадат")}
                    </button>
                    <button className="secondary" onClick={() => rejectCode(m.did)}>
                      {t("Не съвпадат")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {view.isAdmin && view.joined && (
        <>
          <h2>{t("Снимка на групата")}</h2>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              void onPickPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <div className="call-actions">
            <button className="secondary" disabled={busy} onClick={() => photoInput.current?.click()}>
              {view.photo ? t("Смени снимката") : t("Избери снимка")}
            </button>
            {state?.photoHash && (
              <button className="secondary" disabled={busy} onClick={() => void run(() => group.clearPhoto())}>
                {t("Махни снимката")}
              </button>
            )}
          </div>

          <h2>{t("Покани")}</h2>
          {members.length >= MAX_GROUP_MEMBERS && <p>{t("Групата е пълна.")}</p>}
          <ul>
            {invitable.map((c) => (
              <li key={c.did}>
                {c.name}{" "}
                {view.linked.includes(c.did) ? (
                  <button
                    disabled={busy || members.length >= MAX_GROUP_MEMBERS}
                    onClick={() => void run(() => group.invite(c.did, c.name))}
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
                onClick={() => void run(() => group.openSuite(suite))}
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
            <button disabled={busy} onClick={() => void run(() => group.answerSuite(true))}>
              {t("Приеми")}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void run(() => group.answerSuite(false))}>
              {t("Откажи")}
            </button>
          </div>
        </div>
      )}

      {view.joined && (
        <>
          <h2>{t("Съобщения")}</h2>
          <p className="group-history-note">{t("Всеки вижда съобщенията и файловете от момента, в който е влязъл в групата.")}</p>
          <ul
            ref={logRef}
            className="group-log"
            tabIndex={0}
            aria-label={t("Съобщения")}
            style={{ maxHeight: "40vh", overflowY: "auto", listStyle: "none", padding: 0 }}
          >
            {view.messages.map((m) => (
              <li key={m.id}>
                <strong>{m.mine ? t("Вие") : (members.find((x) => x.did === m.from)?.name ?? t("Участник"))}:</strong>{" "}
                {m.file ? (
                  <FileBubble card={m.file} url={view.fileUrls[m.file.id]} load={() => group.loadFile(m.file!.id)} />
                ) : (
                  m.text
                )}
              </li>
            ))}
          </ul>
          {sending && (
            <p role="status">{t("Подготвям „{name}“…", { name: sending })}</p>
          )}
          <TransferList
            items={view.transfers.map((x) => {
              const peerName = members.find((mm) => mm.did === x.peer)?.name ?? t("Участник");
              return {
                id: `${x.peer}|${x.id}`,
                name: x.direction === "out" ? `${x.name} → ${peerName}` : `${peerName}: ${x.name}`,
                size: x.size,
                direction: x.direction,
                phase: x.phase,
                done: x.done,
              };
            })}
            onAccept={(key) => {
              const [peer, id] = key.split("|");
              void group.acceptFile(peer, id);
            }}
            onCancel={(key) => {
              const [peer, id] = key.split("|");
              void group.cancelFile(peer, id);
            }}
          />
          {showGif && <GifPicker onPick={(blob, gifName) => void sendFile(blob, gifName)} onClose={() => setShowGif(false)} />}
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void sendFile(f, f.name);
            }}
          />
          <div className="call-actions group-attach">
            <button
              type="button"
              className="secondary"
              disabled={others.length === 0 || !!sending}
              onClick={() => fileInput.current?.click()}
              aria-label={t("Прикачи файл, снимка или видео до 50 MB")}
            >
              {t("Файл")}
            </button>
            {GIPHY_KEY && (
              <button type="button" className="secondary" disabled={others.length === 0} onClick={() => setShowGif((v) => !v)} aria-expanded={showGif}>
                GIF
              </button>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = draft.trim();
              if (!text) return;
              setDraft("");
              void run(() => group.sendText(text));
            }}
          >
            <label>
              {t("Съобщение")}
              <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} />
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
