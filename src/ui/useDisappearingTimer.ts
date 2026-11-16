import { useState } from "react";
import type { Contact } from "../contacts/contacts";
import { getContact, saveContact } from "../contacts/contacts";
import type { ChatMessage } from "../history/messageStore";
import { TimerSync } from "../history/timerSync";

/**
 * The 1:1 chat's disappearing-messages timer (Н7): kept on the contact (sealed book), shown
 * by `timerMs`, applied to every message about to be written with `withTimer`.
 */
export function useDisappearingTimer(contact: Contact) {
  const [timerMs, setTimerMs] = useState(() => contact.disappearMs ?? 0);
  const [sync] = useState(
    () =>
      new TimerSync(
        { ms: contact.disappearMs, at: contact.disappearAt },
        {
          onChange: (s) => setTimerMs(s.ms),
          persist: async (s) => {
            const fresh = (await getContact(contact.did).catch(() => null)) ?? contact;
            const next: Contact = { ...fresh };
            if (s.ms) next.disappearMs = s.ms;
            else delete next.disappearMs;
            if (s.at) next.disappearAt = s.at;
            else delete next.disappearAt;
            await saveContact(next);
          },
        },
      ),
  );
  /** Adds the expiry of the chat's timer to a message about to be written. */
  const withTimer = (msg: ChatMessage): ChatMessage => {
    const expiresAt = sync.expiryFor(msg.timestamp);
    return expiresAt === undefined ? msg : { ...msg, expiresAt };
  };
  return { timerMs, sync, withTimer };
}
