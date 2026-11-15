/**
 * Device protection settings (Н7): when the app locks itself. Per device in localStorage; not
 * secret (a number of minutes and an on/off).
 */
export const LOCK_MINUTES = [1, 5, 10, 30] as const;
export type LockMinutes = (typeof LOCK_MINUTES)[number];

export interface LockSettings {
  /** Lock after this many minutes without input. */
  minutes: LockMinutes;
  /** Also lock when the app has been in the background for HIDE_GRACE_MS. */
  onHide: boolean;
}

/** Long enough to pick a file or answer a call without being locked out, short enough to matter. */
export const HIDE_GRACE_MS = 30 * 1000;

export const DEFAULT_LOCK: LockSettings = { minutes: 10, onHide: false };

const KEY = "p2p.lock";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadLockSettings(s: Store | null = storage()): LockSettings {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return { ...DEFAULT_LOCK };
    const o = JSON.parse(raw) as Partial<LockSettings>;
    return {
      minutes: (LOCK_MINUTES as readonly number[]).includes(o.minutes as number) ? (o.minutes as LockMinutes) : DEFAULT_LOCK.minutes,
      onHide: typeof o.onHide === "boolean" ? o.onHide : DEFAULT_LOCK.onHide,
    };
  } catch {
    return { ...DEFAULT_LOCK };
  }
}

export function saveLockSettings(value: LockSettings, s: Store | null = storage()): void {
  try {
    s?.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode: the choice lasts for this session only */
  }
}

/** Settings changed in this tab: the app re-reads them (the auto-lock hook listens). */
export const LOCK_EVENT = "p2p-lock-settings";
