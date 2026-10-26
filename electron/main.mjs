/**
 * Linux desktop shell (Electron). It opens one window with the bundled web app and nothing
 * else: no Node.js in the page, no injected scripts, no remote content, no extra windows.
 * Everything the messenger does (crypto, WebRTC, storage) runs in the web code, exactly as
 * in the browser. Electron is used on Linux because the WebKitGTK of Debian and Ubuntu is
 * built without WebRTC, and the direct links between devices need it.
 */
import { app, BrowserWindow, Menu, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, mimeFor, resolveAppFile } from "./appFiles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = `app://${APP_HOST}`;
// Packaged: the web build sits next to the app in resources/. From a checkout: ../dist.
const ROOT = app.isPackaged ? join(process.resourcesPath, "app-dist") : join(here, "..", "dist");

app.setName("p2p-messenger");
// Stable origin = stable storage: IndexedDB (identity, history) lives under this scheme+host.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// No passkeys here: Chromium on Linux has no platform authenticator and shows no prompt for
// one, so a passkey request would only hang. Without WebAuthn the app goes straight to its
// password path (the same one it offers in any browser without passkeys).
app.commandLine.appendSwitch("disable-blink-features", "WebAuth");

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    title: "P2P Messenger",
    width: 480,
    height: 860,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#f1f5fa",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  void win.loadURL(`${ORIGIN}/`);
  win.on("closed", () => {
    win = null;
  });
}

function lockDown() {
  Menu.setApplicationMenu(null);

  // Only camera and microphone (QR scanner, calls), only for the app's own pages.
  const own = (url) => typeof url === "string" && url.startsWith(`${ORIGIN}/`);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) =>
    done(permission === "media" && own(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && own(origin + "/"));

  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
    // The page never leaves the app. A link to a web address opens in the default browser.
    contents.on("will-navigate", (e, url) => {
      if (!own(url)) e.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });

  protocol.handle("app", async (request) => {
    const file = resolveAppFile(ROOT, request.url);
    if (!file) return new Response("Forbidden", { status: 403 });
    try {
      const body = await readFile(file);
      return new Response(body, { headers: { "content-type": mimeFor(file), "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  lockDown();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
