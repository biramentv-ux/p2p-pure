/**
 * Disappearing messages (Н7): a timer per chat. Both people see the same value, because a
 * change is sent as a control message ({t:"timer", ms}) and can only be made while connected.
 * Every message written while the timer is on gets `expiresAt` = time written + timer, on both
 * sides. purgeExpired() (messageStore.ts) deletes the expired rows and their kept files; the
 * app runs it at start and every SWEEP_MS, and the open chat also drops them from the screen.
 *
 * Honest limits (docs/SECURITY-DEVICE.md): the other person can still copy or photograph a
 * message before it goes; deleting a row from IndexedDB does not guarantee the bytes are
 * overwritten on the disk at once (they stay encrypted with the history key).
 */
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The only values allowed on the wire and in the contact record. 0 = off. */
export const DISAPPEAR_OPTIONS = [0, 5 * MINUTE, HOUR, DAY, 7 * DAY] as const;

/** How often the app looks for expired messages. */
export const SWEEP_MS = 30 * 1000;

export function validDisappearMs(ms: unknown): number | null {
  return typeof ms === "number" && (DISAPPEAR_OPTIONS as readonly number[]).includes(ms) ? ms : null;
}

/** When a message written at `timestamp` expires under this timer, or undefined when off. */
export function expiryFor(timestamp: number, ms: number | undefined): number | undefined {
  return ms && validDisappearMs(ms) ? timestamp + ms : undefined;
}

/** Bulgarian source label for a timer value; the UI translates it. */
export function disappearLabel(ms: number): string {
  switch (ms) {
    case 5 * MINUTE:
      return "5 минути";
    case HOUR:
      return "1 час";
    case DAY:
      return "1 ден";
    case 7 * DAY:
      return "1 седмица";
    default:
      return "Изключено";
  }
}
