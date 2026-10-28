/*
 * Loaded by the generated service worker (vite.config.ts: workbox.importScripts).
 * A tap on a message notification brings the open app to the front, or opens it.
 * The notification carries no message content unless the person allowed it in the settings.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if ("focus" in w) return w.focus();
      }
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
