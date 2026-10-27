/*
 * Runs before the page is drawn (classic script, so nothing flashes):
 *  - marks the page as scripted, so the reveal animations are only hidden when they will play;
 *  - applies the saved or system theme;
 *  - sends an installed app (opened from the home screen or the old start address) to the messenger.
 * No data leaves the device. Storage is optional: every access is guarded.
 */
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  var theme = "";
  try { theme = localStorage.getItem("site-theme") || ""; } catch (_e) { /* private mode */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.setAttribute("data-theme", theme);

  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  } catch (_e) { /* ignore */ }
  var forced = /[?&]site=1(?:&|$)/.test(location.search);
  if (standalone && !forced) {
    location.replace("app/" + location.search + location.hash);
  }
})();
