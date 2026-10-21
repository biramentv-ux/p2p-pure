import { openMessenger } from "./launch.js";

// The keyboard shortcut from manifest.json. Registered at the top level, so the
// worker can handle it as soon as Chrome starts it.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-messenger") return;
  try {
    await openMessenger();
  } catch (err) {
    console.error("Could not open the messenger:", err);
  }
});
