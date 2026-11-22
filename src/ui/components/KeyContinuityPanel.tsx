/**
 * П7: "this is the new key of someone I knew" in a chat (docs/KEY-CONTINUITY.md).
 *
 *  - I met them again and compared the 12 words with the new key: I can confirm it, which signs a
 *    statement for them to keep (vouch-grant).
 *  - I did not: I ask them to show the statements of others (vouch-ask / vouch-list) and count
 *    only those signed by my own verified contacts. Then I decide.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { linkKeyChange, listContacts, type Contact } from "../../contacts/contacts";
import type { VouchMessage } from "../../p2p/control";
import { signVouch } from "../../trust/vouch";
import type { Me, useKeyContinuity } from "../useKeyContinuity";

export function KeyContinuityPanel({ me, kc, send }: { me: Me | undefined; kc: ReturnType<typeof useKeyContinuity>; send: (m: VouchMessage) => Promise<void> }) {
  const { t } = useI18n();
  const [candidates, setCandidates] = useState<Contact[]>([]);
  const [old, setOld] = useState("");
  const contact = kc.current;

  useEffect(() => {
    let alive = true;
    void listContacts().then((all) => {
      if (alive) setCandidates(all.filter((c) => c.did !== contact.did && c.verified && !c.replacedBy && c.did !== contact.succeeds?.did));
    });
    return () => {
      alive = false;
    };
  }, [contact.did, contact.succeeds?.did]);

  if (!me) return null;
  const oldContact = candidates.find((c) => c.did === old) ?? null;
  const verdict = kc.asking?.old === old ? kc.asking.verdict : undefined;

  const confirmMyself = async () => {
    if (!oldContact) return;
    await send({ t: "vouch-grant", v: signVouch(me, oldContact.did, contact.did) });
    await linkKeyChange(oldContact.did, contact.did, []);
    kc.setNotice(t("Потвърди, че {name} е новият ключ на {old}. Той пази подписа ти.", { name: contact.name, old: oldContact.name }));
    await kc.reload();
  };
  const ask = async () => {
    if (!oldContact) return;
    kc.setAsking({ old: oldContact.did, oldName: oldContact.name });
    await send({ t: "vouch-ask", old: oldContact.did });
  };
  const accept = async () => {
    if (!oldContact) return;
    await linkKeyChange(oldContact.did, contact.did, verdict?.confirmedBy.map((w) => w.name) ?? []);
    kc.setNotice(t("{name} е отбелязан като новия ключ на {old}.", { name: contact.name, old: oldContact.name }));
    kc.setAsking(null);
    await kc.reload();
  };

  return (
    <details className="key-continuity">
      <summary>{t("Нов ключ на познат човек?")}</summary>
      {contact.succeeds ? (
        <p role="note">
          {contact.succeeds.by.length
            ? t("Нов ключ на {old}. Потвърдено от: {names}.", { old: contact.succeeds.name, names: contact.succeeds.by.join(", ") })
            : t("Нов ключ на {old}. Решено по твоята проверка.", { old: contact.succeeds.name })}
        </p>
      ) : (
        <>
          <p className="hint">
            {t("Ако някой е загубил 12-те си думи и е започнал с нов ключ, общите ви контакти, които са го проверили, могат да го потвърдят.")}
          </p>
          <label>
            {t("Стар контакт")}
            <select value={old} onChange={(e) => setOld(e.target.value)}>
              <option value="">{t("Избери…")}</option>
              {candidates.map((c) => (
                <option key={c.did} value={c.did}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="button" className="ghost" disabled={!oldContact} onClick={() => void ask()}>
              {t("Поискай потвърждения")}
            </button>
            <button type="button" className="ghost" disabled={!oldContact || !contact.verified} onClick={() => void confirmMyself()}>
              {t("Аз го проверих: потвърждавам")}
            </button>
          </div>
          {!contact.verified && <p className="hint">{t("Да потвърдиш сам можеш след като сравните 12-те думи с новия ключ.")}</p>}
          {kc.asking?.old === old && !verdict && <p role="status">{t("Чакам отговор…")}</p>}
          {verdict && (
            <div role="status">
              <p>
                {verdict.confirmedBy.length
                  ? t("Потвърждават твоите проверени контакти: {names}.", { names: verdict.confirmedBy.map((w) => w.name).join(", ") })
                  : t("Никой от проверените ти контакти не потвърждава.")}
                {verdict.ignored > 0 && " " + t("Пренебрегнати потвърждения (непознати или непроверени подписващи): {n}.", { n: String(verdict.ignored) })}
              </p>
              <button type="button" disabled={!verdict.confirmedBy.length && !contact.verified} onClick={() => void accept()}>
                {t("Приеми: това е {old}", { old: oldContact?.name ?? "" })}
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
