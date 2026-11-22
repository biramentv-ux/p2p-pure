/*
 * Notifications for messages from people you know: a saved contact in a one-to-one chat, or a
 * member of a group you are in. Nobody else can reach this device anyway (every link starts with
 * a QR code or a code you entered), but the check is explicit so it stays true.
 *
 * There is no server, so there is no push: a notification can only come while the app is running
 * (open, or in a background tab / minimised window). That is said in the settings.
 *
 * What is shown (decide()):
 *   - the chat is open and the window is in front: nothing, you are reading it;
 *   - the window is in front, another screen is open: the sound only;
 *   - the window is hidden or not focused: the sound, a system notification (if allowed) and the
 *     number of unread messages in the window title.
 * The notification says only who wrote, not what, unless the person turns on "show the text":
 * notifications are kept by the operating system, outside the app's encryption.
 *
 * Settings are per device in localStorage. They are not secret (on/off, a sound, a volume).
 */
import { androidNotify, androidPermission, askAndroidPermission, backgroundLinkPlugin, refreshAndroidPermission } from "../platform/mobile/backgroundLink";
import { DEFAULT_SOUND, isSoundId, playSound, primeAudio, type SoundId } from "./sounds";

export interface NotifySettings {
  /** Sounds and notifications for new messages. */
  enabled: boolean;
  sound: SoundId;
  /** 0..1 */
  volume: number;
  /** Put the message text in the system notification (off: only who wrote). */
  showText: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = { enabled: true, sound: DEFAULT_SOUND, volume: 0.7, showText: false };

const KEY = "p2p.notify";

type Store = Pick<Storage, "getItem" | "setItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadNotifySettings(s: Store | null = storage()): NotifySettings {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return { ...DEFAULT_NOTIFY };
    const o = JSON.parse(raw) as Partial<NotifySettings>;
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_NOTIFY.enabled,
      sound: isSoundId(o.sound) ? o.sound : DEFAULT_NOTIFY.sound,
      volume: typeof o.volume === "number" && o.volume >= 0 && o.volume <= 1 ? o.volume : DEFAULT_NOTIFY.volume,
      showText: typeof o.showText === "boolean" ? o.showText : DEFAULT_NOTIFY.showText,
    };
  } catch {
    return { ...DEFAULT_NOTIFY };
  }
}

export function saveNotifySettings(value: NotifySettings, s: Store | null = storage()): void {
  try {
    s?.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode: the choice lasts for this session only */
  }
}

export interface Incoming {
  /** One chat or group: notifications from it replace each other instead of piling up. */
  chatId: string;
  /** The sender is a saved contact, or a member of a group this device is in. */
  known: boolean;
  /** Already translated: "Ани", or "Семейство · Ани". */
  title: string;
  /** Already translated: the text, or "Снимка", "Файл: x.pdf"… */
  preview: string;
  /** Already translated: what to show instead of the text ("Ново съобщение"). */
  hidden: string;
}

export interface Surroundings {
  /** The window is in front and focused. */
  visible: boolean;
  /** The chat or group this message belongs to is the screen that is open. */
  open: boolean;
  /** "granted", "denied", "default", or "unsupported". */
  permission: string;
}

export interface Decision {
  sound: boolean;
  system: boolean;
  /** Count it in the window title. */
  unread: boolean;
}

export function decide(msg: Pick<Incoming, "known">, where: Surroundings, settings: NotifySettings): Decision {
  const none = { sound: false, system: false, unread: false };
  if (!settings.enabled || !msg.known) return none;
  if (where.visible && where.open) return none;
  if (where.visible) return { sound: settings.sound !== "none", system: false, unread: false };
  return { sound: settings.sound !== "none", system: where.permission === "granted", unread: true };
}

/** At most this many characters of a message go into a notification. */
export const PREVIEW_CHARS = 80;

export function previewText(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
}

/* ------------------------------------------------------------------ the browser side */

export function permission(): string {
  // П3: in the Android app the system notification goes through the native plugin.
  if (backgroundLinkPlugin()) return androidPermission();
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  return N ? N.permission : "unsupported";
}

/** Asks the system for permission. Must run from a tap (browsers refuse otherwise). */
export async function askPermission(): Promise<string> {
  if (backgroundLinkPlugin()) return askAndroidPermission();
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  if (!N) return "unsupported";
  try {
    return await N.requestPermission();
  } catch {
    return N.permission;
  }
}

function windowVisible(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
}

let unread = 0;
let baseTitle: string | null = null;

function showUnread(): void {
  if (typeof document === "undefined") return;
  if (baseTitle === null) baseTitle = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = `(${unread}) ${baseTitle}`;
}

function clearUnread(): void {
  if (typeof document === "undefined" || unread === 0) return;
  unread = 0;
  if (baseTitle !== null) document.title = baseTitle;
  baseTitle = null;
}

async function systemNotification(msg: Incoming, settings: NotifySettings): Promise<void> {
  const body = settings.showText ? msg.preview : msg.hidden;
  if (backgroundLinkPlugin()) {
    await androidNotify(msg.chatId, msg.title, body);
    return;
  }
  const options: NotificationOptions = { body, tag: msg.chatId, icon: "icons/icon-192.png", silent: true };
  try {
    // Android Chrome only shows notifications through the service worker; elsewhere it is the same.
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification(msg.title, options);
      return;
    }
  } catch {
    /* fall through to the page notification */
  }
  try {
    const n = new Notification(msg.title, options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* not allowed here (some webviews): the sound and the title counter still tell */
  }
}

/**
 * Call for every message that arrives. `open` = its chat is the screen in front.
 * Returns what was done (for tests and logs; it never throws).
 */
export function notifyIncoming(msg: Incoming, open: boolean, settings: NotifySettings = loadNotifySettings()): Decision {
  const d = decide(msg, { visible: windowVisible(), open, permission: permission() }, settings);
  if (d.sound) playSound(settings.sound, settings.volume);
  if (d.unread) {
    unread += 1;
    showUnread();
  }
  if (d.system) void systemNotification(msg, settings);
  return d;
}

let installed = false;

/**
 * Once at start: unlocks audio on the first tap or key press, and clears the unread counter when
 * the window comes back to the front.
 */
export function installNotifier(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const prime = () => primeAudio();
  window.addEventListener("pointerdown", prime, { passive: true });
  void refreshAndroidPermission();
  window.addEventListener("keydown", prime);
  const back = () => {
    if (windowVisible()) clearUnread();
  };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
}
