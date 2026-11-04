/*
 * Runs before the page is drawn (classic script, so nothing flashes):
 *  - marks the page as scripted, so the reveal animations are only hidden when they will play;
 *  - applies the saved or system theme;
 *  - sends an installed app (opened from the home screen or the old start address) to the messenger;
 *  - opens the page of the language the visitor chose before (only a stored choice, never
 *    a guess from the browser, so search engines always see the page they asked for).
 * No data leaves the device. Storage is optional: every access is guarded.
 */
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  var theme = "";
  try { theme = localStorage.getItem("site-theme") || ""; } catch { /* private mode */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.setAttribute("data-theme", theme);

  var standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  } catch { /* ignore */ }
  var forced = /[?&]site=1(?:&|$)/.test(location.search);
  var base = root.getAttribute("data-root") || ""; // "" on "/", "../" on "/en/", "/es/" …
  if (standalone && !forced) {
    location.replace(base + "app/" + location.search + location.hash);
    return;
  }

  var chosen = "";
  try { chosen = localStorage.getItem("site-lang") || ""; } catch { /* private mode */ }
  // data-langs is written by the build from site/locales.js; the first code is the page at "/"
  var codes = (root.getAttribute("data-langs") || "").split(" ");
  var here = root.getAttribute("data-lang") || codes[0];
  if (chosen && chosen !== here && codes.indexOf(chosen) >= 0) {
    var target = base + (chosen === codes[0] ? "" : chosen + "/");
    location.replace((target || "./") + location.search + location.hash);
  }
})();
