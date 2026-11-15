/**
 * Disappearing messages (Н7): a timer per chat. Both people see the same value: a change is
 * sent as a control message ({t:"timer", ms, at}), each chat screen also sends its current
 * setting when it opens, and newerTimer() picks the same winner on both sides.
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

/** A timer setting: the value and when it was chosen (ms since epoch, 0 = never set). */
export interface TimerSetting {
  ms: number;
  at: number;
}

/**
 * Which of two settings stands. Both devices run this on the same two settings, so they end
 * on the same value even when both people change the timer at the same moment, and when
 * they reconnect after changing it while apart: the later choice wins; on an exact tie the
 * shorter timer wins (an "off" counts as the longest), the safer of the two.
 */
export function newerTimer(a: TimerSetting, b: TimerSetting): TimerSetting {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  const rank = (ms: number) => (ms === 0 ? Number.POSITIVE_INFINITY : ms);
  return rank(a.ms) <= rank(b.ms) ? a : b;
}
