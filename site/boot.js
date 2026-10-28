/*
 * Runs before the page is drawn (classic script, so nothing flashes):
 *  - marks the page as scripted, so the reveal animations are only hidden when they will play;
 *  - applies the saved or system theme;
 *  - sends an installed app (opened from the home screen or the old start address) to the messenger;
 *  - opens the other language's page when the visitor chose it before (only a stored choice, never
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
  var base = root.getAttribute("data-root") || ""; // "" on "/", "../" on "/en/"
  if (standalone && !forced) {
    location.replace(base + "app/" + location.search + location.hash);
    return;
  }

  var chosen = "";
  try { chosen = localStorage.getItem("site-lang") || ""; } catch { /* private mode */ }
  var other = root.getAttribute("data-other");
  if (other && (chosen === "bg" || chosen === "en") && chosen !== root.lang) {
    location.replace(other + location.search + location.hash);
  }
})();
