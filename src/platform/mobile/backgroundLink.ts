/**
 * П3: notifications without a push server, Android app only (BackgroundLinkPlugin.java).
 *
 * A browser or PWA cannot keep a connection when it is closed, and a push server is out (no
 * central servers). On Android the app can keep its own process alive with a foreground service:
 * the live links and the rendezvous listening keep running with the screen off, and new messages
 * become system notifications. It costs battery, so it is off until the person turns it on.
 *
 * UnifiedPush is deliberately not used: it needs a distributor (an ntfy server). Someone else's
 * server breaks the rule; your own is still a server. docs/NOTIFICATIONS.md.
 */
interface Plugin {
  start(o: { title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
  notify(o: { tag: string; title: string; body: string }): Promise<void>;
  permission(): Promise<{ state: string }>;
  askPermission(): Promise<{ state: string }>;
  batterySettings(): Promise<void>;
}

interface Windowish {
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, unknown> };
}

const SETTING_KEY = "p2p-background-link";

/** The plugin in the Android app, else null. */
export function backgroundLinkPlugin(win: Windowish = globalThis as unknown as Windowish): Plugin | null {
  const cap = win.Capacitor;
  if (!cap?.isNativePlatform?.() || cap.getPlatform?.() !== "android") return null;
  return (cap.Plugins?.BackgroundLink as Plugin | undefined) ?? null;
}

export function backgroundLinkEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

let cachedPermission = "default";

/** The notification permission as the notifier sees it ("granted", "denied", "default"). */
export function androidPermission(): string {
  return cachedPermission;
}

export async function refreshAndroidPermission(plugin = backgroundLinkPlugin()): Promise<string> {
  if (!plugin) return cachedPermission;
  cachedPermission = (await plugin.permission().catch(() => ({ state: "denied" }))).state;
  return cachedPermission;
}

export async function askAndroidPermission(plugin = backgroundLinkPlugin()): Promise<string> {
  if (!plugin) return "unsupported";
  cachedPermission = (await plugin.askPermission().catch(() => ({ state: "denied" }))).state;
  return cachedPermission;
}

export async function androidNotify(tag: string, title: string, body: string, plugin = backgroundLinkPlugin()): Promise<void> {
  await plugin?.notify({ tag, title, body }).catch(() => undefined);
}

/**
 * Starts or stops the foreground service. Started only when the setting is on and the identity is
 * unlocked (locked, there is nothing to keep: the links are closed and the keys are out of memory).
 */
export async function syncBackgroundLink(unlocked: boolean, texts: { title: string; text: string }, plugin = backgroundLinkPlugin()): Promise<boolean> {
  if (!plugin) return false;
  const on = unlocked && backgroundLinkEnabled();
  try {
    if (on) await plugin.start(texts);
    else await plugin.stop();
  } catch {
    return false;
  }
  return on;
}

export function setBackgroundLinkEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    /* stays off */
  }
}

export async function openBatterySettings(plugin = backgroundLinkPlugin()): Promise<void> {
  await plugin?.batterySettings().catch(() => undefined);
}

/**
 * The texts of the permanent notification while the app keeps its links up. Literal keys, so the
 * i18n test sees them; `t` translates.
 */
export function backgroundLinkTexts(t: (s: string) => string): { title: string; text: string } {
  return { title: t("P2P държи връзката"), text: t("Съобщенията идват и при изключен екран, докато това известие е тук.") };
}
