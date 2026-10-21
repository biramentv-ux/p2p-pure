/*
 * Shared launch logic for the popup and the service worker.
 *
 * Both functions are stateless: the service worker can stop at any moment, so nothing
 * is kept in memory between events. The tab is found again on every call.
 */

export const APP_URL = "https://dyrakarmy.online/";
const APP_URL_PATTERN = `${APP_URL}*`;

/** True when a tab already runs the messenger. Uses only the host permission. */
export async function isMessengerOpen() {
  const tabs = await chrome.tabs.query({ url: APP_URL_PATTERN });
  return tabs.length > 0;
}

/** Brings the existing messenger tab forward, or opens a new one. */
export async function openMessenger() {
  const [existing] = await chrome.tabs.query({ url: APP_URL_PATTERN });
  if (existing?.id !== undefined) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return { tabId: existing.id, reused: true };
  }
  const tab = await chrome.tabs.create({ url: APP_URL });
  return { tabId: tab.id, reused: false };
}

/** A small separate window, which feels like an app. Always a new window. */
export async function openMessengerWindow() {
  const win = await chrome.windows.create({
    url: APP_URL,
    type: "popup",
    width: 420,
    height: 760,
    focused: true,
  });
  return { windowId: win.id };
}
