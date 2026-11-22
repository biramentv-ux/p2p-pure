/**
 * П7: the vouch-* side of a chat (docs/KEY-CONTINUITY.md). The panel is KeyContinuityPanel.tsx.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { getContact, keepVouchFrom, listContacts, type Contact } from "../contacts/contacts";
import type { VouchMessage } from "../p2p/control";
import type { Ed25519KeyPair } from "../identity/types";
import { judgeVouches, vouchSignatureOk, type VouchVerdict, type Witness } from "../trust/vouch";

export interface Me {
  did: string;
  keyPair: Ed25519KeyPair;
}

export interface Asking {
  old: string;
  oldName: string;
  verdict?: VouchVerdict;
}

/** The vouch-* side of a chat. `send` puts a control message into the encrypted session. */
export function useKeyContinuity(contact: Contact, me: Me | undefined, send: (m: VouchMessage) => Promise<void>) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [current, setCurrent] = useState<Contact>(contact);
  const askingRef = useRef<Asking | null>(null);
  useEffect(() => {
    askingRef.current = asking;
  }, [asking]);

  const reload = useCallback(async () => {
    const c = await getContact(contact.did);
    if (c) setCurrent(c);
  }, [contact.did]);

  const handle = useCallback(
    async (m: VouchMessage) => {
      if (!me) return;
      if (m.t === "vouch-grant") {
        // Only a statement this person signed about me, now.
        if (m.v.by !== contact.did || m.v.new !== me.did || !vouchSignatureOk(m.v)) return;
        await keepVouchFrom(contact.did, m.v);
        setNotice(t("{name} потвърди, че си същият човек с нов ключ. Пазиш това потвърждение и можеш да го покажеш на общи контакти.", { name: contact.name }));
        return;
      }
      if (m.t === "vouch-ask") {
        // Answer only someone I verified myself; show only statements about that old key.
        if (!contact.verified) return;
        const vs = (await listContacts()).flatMap((c) => c.vouchesForMe ?? []).filter((v) => v.old === m.old && v.new === me.did);
        await send({ t: "vouch-list", old: m.old, vs });
        return;
      }
      const a = askingRef.current;
      if (!a || a.old !== m.old) return;
      const book = new Map<string, Witness>((await listContacts()).map((c) => [c.did, { did: c.did, name: c.name, verified: c.verified }]));
      setAsking({ ...a, verdict: judgeVouches(m.vs, a.old, contact.did, (d) => book.get(d) ?? null) });
    },
    [contact.did, contact.name, contact.verified, me, send, t],
  );

  const startAsking = useCallback((a: Asking | null) => {
    askingRef.current = a;
    setAsking(a);
  }, []);

  return { handle, asking, setAsking: startAsking, notice, setNotice, current, reload };
}
