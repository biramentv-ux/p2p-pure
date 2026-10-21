import { isMessengerOpen, openMessenger, openMessengerWindow } from "./launch.js";

const message = (key) => chrome.i18n.getMessage(key) || key;

/** Fills every [data-i18n] element with the text for the browser's language. */
function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = message(el.dataset.i18n);
  }
}

function showError(err) {
  console.error(err);
  const box = document.getElementById("error");
  box.textContent = message("errorGeneric");
  box.hidden = false;
}

async function run(action) {
  document.getElementById("error").hidden = true;
  try {
    await action();
    window.close();
  } catch (err) {
    showError(err);
  }
}

async function main() {
  localize();
  const status = document.getElementById("status");
  try {
    const open = await isMessengerOpen();
    status.textContent = message(open ? "statusOpen" : "statusClosed");
  } catch (err) {
    showError(err);
  }
  document.getElementById("open").addEventListener("click", () => run(openMessenger));
  document.getElementById("open-window").addEventListener("click", () => run(openMessengerWindow));
}

void main();
