import { useEffect, useState, useSyncExternalStore } from "react";
import { listContacts, markContactVerified, type Contact } from "../../contacts/contacts";
import type { IntroHub, HubSnapshot, InviteView, IntroductionView, RequestView } from "../../intro/introHub";
import { formatSafetyCode, safetyWords } from "../../p2p/safety";
import { identityX25519Public } from "../../identity/x25519";
import { useI18n } from "../../i18n";

/** What the screen opens with: flow (a), or flow (b) asking one contact. */
export type IntroduceMode = { k: "hub" } | { k: "pair" } | { k: "ask"; contact: Contact };

interface IntroduceScreenProps {
  hub: IntroHub;
  mode: IntroduceMode;
  myPublicKey: Uint8Array;
  /** Opens the normal connect flow for a link that goes into the hub. */
  onLink: (contact: Contact) => void;
  /** Opens a chat on a link the hub made by an introduction. */
  onChat: (did: string) => void;
  /** "Край": closes every introduction link. */
  onClose: () => void;
  onBack: () => void;
}

function useHub(hub: IntroHub): HubSnapshot {
  return useSyncExternalStore(
    (fn) => hub.subscribe(fn),
    () => hub.snapshot,
  );
}

function minutesLeft(exp: number): number {
  return Math.max(0, Math.ceil((exp - Date.now()) / 60_000));
}

export function IntroduceScreen({ hub, mode, myPublicKey, onLink, onChat, onClose, onBack }: IntroduceScreenProps) {
  const { t } = useI18n();
  const view = useHub(hub);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pickA, setPickA] = useState<string>("");
  const [pickB, setPickB] = useState<string>("");
  /** Flow (b) at C: the request being answered. */
  const [answering, setAnswering] = useState<RequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The new contact whose safety code is open. */
  const [checking, setChecking] = useState<string | null>(null);
  const [verified, setVerified] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void listContacts()
      .then((list) => alive && setContacts(list))
      .catch(() => alive && setError("Контактите не можаха да се заредят."));
    return () => {
      alive = false;
    };
  }, [view.fresh.length]);

  // The "ask" mode starts with the asked contact preselected.
  const askDid = mode.k === "ask" ? mode.contact.did : null;

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нещо се обърка.");
    } finally {
      setBusy(false);
    }
  }

  const byDid = (did: string) => contacts.find((c) => c.did === did);
  const nameOf = (did: string) => byDid(did)?.name ?? did.slice(0, 16) + "…";

  /* ---------- pieces ---------- */

  function linkRow(c: Contact) {
    const linked = hub.isLinked(c.did);
    return (
      <span className="call-actions">
        {linked ? (
          <span className="badge">{t("свързан")}</span>
        ) : (
          <button className="secondary" onClick={() => onLink(c)}>
            {t("Свържи")}
          </button>
        )}
      </span>
    );
  }

  function introductionState(i: IntroductionView): string {
    const side = (s: string) =>
      s === "accepted" ? t("прие") : s === "declined" ? t("отказа") : t("чака");
    switch (i.state) {
      case "sent":
        return t("{a}: {sa} · {b}: {sb}", { a: i.a.name, sa: side(i.aState), b: i.b.name, sb: side(i.bState) });
      case "ready":
        return t("И двамата приеха. Свързват се…");
      case "done":
        return t("Готово: {a} и {b} се свързаха през теб.", { a: i.a.name, b: i.b.name });
      case "declined":
        return t("Запознанството е отказано.");
      case "cancelled":
        return t("Запознанството е отменено.");
      default:
        return t("Запознанството изтече.");
    }
  }

  function inviteState(inv: InviteView): string {
    switch (inv.state) {
      case "accepted":
        return t("Прие. Чакаме {name} да отговори.", { name: inv.peer.name });
      case "linking":
        return t("Свързване с {name}…", { name: inv.peer.name });
      case "done":
        return t("Свързани сте с {name}.", { name: inv.peer.name });
      case "declined":
        return t("Отказа.");
      case "cancelled":
        return t("Запознанството е отменено.");
      case "expired":
        return t("Поканата изтече.");
      case "failed":
        return inv.error ? t(inv.error) : t("Връзката не можа да се направи.");
      default:
        return "";
    }
  }

  const pending = view.invites.filter((i) => i.state === "pending");
  const otherInvites = view.invites.filter((i) => i.state !== "pending");
  const pendingRequests = view.requestsIn.filter((r) => r.state === "pending");
  const choiceA = answering ? answering.peer.did : pickA;
  const contactA = choiceA ? byDid(choiceA) : undefined;
  const contactB = pickB ? byDid(pickB) : undefined;
  const showPair = mode.k === "pair" || answering !== null;

  return (
    <section className="screen" aria-labelledby="intro-title">
      <h1 id="intro-title">{t("Запознанства")}</h1>
      <p>
        {t(
          "Общ познат може да те свърже с човек, когото още не познаваш. Всичко минава през шифрованите ви връзки, без сървър.",
        )}
      </p>
      {(error || view.error) && (
        <p role="alert" className="chat-notice">
          {t((error ?? view.error) as string)}
        </p>
      )}

      {/* Incoming invitations: the consent prompt. */}
      {pending.map((inv) => (
        <div key={inv.id} role="group" aria-label={t("Покана за запознанство")} className="call-panel">
          <p>
            <strong>
              {t("{c} иска да те запознае с {b}", { c: inv.via.name, b: inv.peer.name })}
            </strong>
          </p>
          {inv.requested && <p>{t("Това е отговор на твоята молба.")}</p>}
          {inv.known && <p>{t("{name} вече е в контактите ти.", { name: inv.peer.name })}</p>}
          <p className="did-text" title={inv.peer.did}>
            {inv.peer.did.slice(0, 28)}…
          </p>
          <p>{t("Изтича след {n} мин.", { n: minutesLeft(inv.exp) })}</p>
          {inv.error && <p role="alert">{t(inv.error)}</p>}
          <div className="call-actions">
            <button disabled={busy} onClick={() => void run(() => hub.accept(inv.id))}>
              {t("Приеми")}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void run(() => hub.decline(inv.id))}>
              {t("Откажи")}
            </button>
          </div>
        </div>
      ))}

      {/* Incoming requests (flow b, at C). */}
      {pendingRequests.map((r) => (
        <div key={r.id} role="group" aria-label={t("Молба за запознанство")} className="call-panel">
          <p>
            <strong>{t("{name} те моли да го запознаеш с някого", { name: r.peer.name })}</strong>
          </p>
          <p>{t("Ти избираш с кого. {name} не вижда списъка ти с контакти.", { name: r.peer.name })}</p>
          <div className="call-actions">
            <button
              disabled={busy}
              onClick={() => {
                setAnswering(r);
                setPickB("");
              }}
            >
              {t("Избери човек")}
            </button>
            <button className="secondary" disabled={busy} onClick={() => void run(() => hub.declineRequest(r.id))}>
              {t("Откажи")}
            </button>
          </div>
        </div>
      ))}

      {/* Flow (a), or answering a request: pick two contacts, link to both, send. */}
      {showPair && (
        <div role="group" aria-labelledby="intro-pair-title">
          <h2 id="intro-pair-title">
            {answering ? t("Запознай {name} с…", { name: answering.peer.name }) : t("Запознай двама")}
          </h2>
          {!answering && (
            <label>
              {t("Първи човек")}
              <select value={pickA} onChange={(e) => setPickA(e.target.value)}>
                <option value="">{t("— избери —")}</option>
                {contacts
                  .filter((c) => c.did !== pickB)
                  .map((c) => (
                    <option key={c.did} value={c.did}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            {answering ? t("С кого") : t("Втори човек")}
            <select value={pickB} onChange={(e) => setPickB(e.target.value)}>
              <option value="">{t("— избери —")}</option>
              {contacts
                .filter((c) => c.did !== choiceA)
                .map((c) => (
                  <option key={c.did} value={c.did}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <ul className="contact-list">
            {[contactA, contactB].filter((c): c is Contact => !!c).map((c) => (
              <li key={c.did} className="contact">
                <div className="contact-info">
                  <strong>{c.name}</strong>
                </div>
                <div className="contact-actions">{linkRow(c)}</div>
              </li>
            ))}
          </ul>
          <p>
            {t(
              "И двамата трябва да са свързани с теб сега. Те отварят „Контакти“ → „Запознанства“ и се свързват с теб. После всеки приема или отказва.",
            )}
          </p>
          <div className="call-actions">
            <button
              disabled={busy || !contactA || !contactB || !hub.isLinked(contactA.did) || !hub.isLinked(contactB.did)}
              onClick={() =>
                void run(async () => {
                  if (!contactA || !contactB) return;
                  await hub.introduce(contactA, contactB, answering?.id);
                  setAnswering(null);
                  setPickA("");
                  setPickB("");
                })
              }
            >
              {t("Изпрати поканите")}
            </button>
            {answering && (
              <button className="secondary" onClick={() => setAnswering(null)}>
                {t("Назад")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Flow (b) at A: ask one contact. */}
      {mode.k === "ask" && (
        <div role="group" aria-labelledby="intro-ask-title">
          <h2 id="intro-ask-title">{t("Помоли {name} за запознанство", { name: mode.contact.name })}</h2>
          <p>
            {t(
              "{name} ще избере човек от своите контакти. Ти не виждаш списъка, а {name} не вижда твоя. Накрая пак решаваш дали да приемеш.",
              { name: mode.contact.name },
            )}
          </p>
          <div className="call-actions">
            {linkRow(mode.contact)}
            <button
              disabled={busy || !askDid || !hub.isLinked(askDid)}
              onClick={() => void run(() => hub.requestIntroduction(mode.contact.did))}
            >
              {t("Изпрати молбата")}
            </button>
          </div>
        </div>
      )}

      {/* Progress. */}
      {(view.introductions.length > 0 || otherInvites.length > 0 || view.requestsOut.length > 0) && (
        <>
          <h2>{t("Ход")}</h2>
          <ul className="contact-list" aria-live="polite">
            {view.introductions.map((i) => (
              <li key={i.id} className="contact">
                <div className="contact-info">
                  <strong>{t("{a} и {b}", { a: i.a.name, b: i.b.name })}</strong>
                  <span>{introductionState(i)}</span>
                </div>
                {(i.state === "sent" || i.state === "ready") && (
                  <div className="contact-actions">
                    <button className="secondary" onClick={() => void run(() => hub.cancelIntroduction(i.id))}>
                      {t("Отмени")}
                    </button>
                  </div>
                )}
              </li>
            ))}
            {view.requestsOut.map((r) => (
              <li key={r.id} className="contact">
                <div className="contact-info">
                  <strong>{t("Молба до {name}", { name: r.peer.name })}</strong>
                  <span>
                    {r.state === "sent"
                      ? t("Чака отговор.")
                      : r.state === "answered"
                        ? t("{name} предложи човек.", { name: r.peer.name })
                        : r.state === "declined"
                          ? t("{name} отказа.", { name: r.peer.name })
                          : t("Молбата изтече.")}
                  </span>
                </div>
              </li>
            ))}
            {otherInvites.map((inv) => {
              const fresh = view.fresh.some((f) => f.did === inv.peer.did);
              const saved = byDid(inv.peer.did);
              const isVerified = saved?.verified || verified.has(inv.peer.did);
              return (
                <li key={inv.id} className="contact">
                  <div className="contact-info">
                    <strong>{inv.peer.name}</strong>
                    <span className="badge">{t("Запознати чрез {c}", { c: inv.via.name })}</span>
                    <span>{inviteState(inv)}</span>
                  </div>
                  {inv.state === "done" && (
                    <div className="contact-actions">
                      {fresh && <button onClick={() => onChat(inv.peer.did)}>{t("Отвори чата")}</button>}
                      {saved && !isVerified && (
                        <button className="secondary" onClick={() => setChecking(checking === inv.peer.did ? null : inv.peer.did)}>
                          {t("Сравни кода")}
                        </button>
                      )}
                    </div>
                  )}
                  {saved && !isVerified && checking === inv.peer.did && (
                    <div role="group" aria-label={t("Код за сигурност")} className="call-panel">
                      <p>
                        {t(
                          "{c} ви запозна, но името е избрано от {c}. Сравнете думите с {name} лично или по видео.",
                          { c: inv.via.name, name: inv.peer.name },
                        )}
                      </p>
                      <p className="safety-code" aria-label={t("Код за сигурност")}>
                        {formatSafetyCode(safetyWords(identityX25519Public(myPublicKey), identityX25519Public(saved.publicKey)))}
                      </p>
                      <div className="call-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await markContactVerified(saved.did);
                              setVerified((s) => new Set(s).add(saved.did));
                              setChecking(null);
                            })
                          }
                        >
                          {t("Думите съвпадат")}
                        </button>
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
              );
            })}
          </ul>
        </>
      )}

      {view.linked.length > 0 && (
        <p>
          {t("Свързан за запознанства с: {names}", { names: view.linked.map((p) => nameOf(p.did)).join(", ") })}
        </p>
      )}

      <div className="call-actions">
        <button className="secondary" onClick={onBack}>
          {t("Към контактите")}
        </button>
        <button className="secondary" onClick={onClose}>
          {t("Край на запознанствата")}
        </button>
      </div>
    </section>
  );
}
