/**
 * Linux desktop shell (Electron). It opens one window with the bundled web app and nothing
 * else: no Node.js in the page, no injected scripts, no remote content, no extra windows.
 * Everything the messenger does (crypto, WebRTC, storage) runs in the web code, exactly as
 * in the browser. Electron is used on Linux because the WebKitGTK of Debian and Ubuntu is
 * built without WebRTC, and the direct links between devices need it.
 */
import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST, mimeFor, resolveAppFile } from "./appFiles.mjs";
import { createNativeNet } from "./nativeNet.mjs";

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
      // П4 (experiment): window.p2pNative for the native transport. Inert until the person
      // turns the experiment on in Settings; the page asks for every socket itself.
      preload: join(here, "preload.cjs"),
    },
  });
  void win.loadURL(`${ORIGIN}/`);
  win.on("closed", () => {
    win = null;
  });
}

function lockDown() {
  Menu.setApplicationMenu(null);

  // Camera and microphone (QR scanner, calls) and writing to the clipboard (the copy buttons),
  // only for the app's own pages. Reading the clipboard stays refused.
  const allowed = new Set(["media", "clipboard-sanitized-write"]);
  const own = (url) => typeof url === "string" && url.startsWith(`${ORIGIN}/`);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) =>
    done(allowed.has(permission) && own(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && own(origin + "/"));

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

/** П4: UDP sockets and LAN HTTP for the native transport, for the app's own page only. */
function nativeTransport() {
  const own = (e) => typeof e.senderFrame?.url === "string" && e.senderFrame.url.startsWith(`${ORIGIN}/`);
  const net = createNativeNet((id, bytes, host, port) => win?.webContents.send("p2p-native:udp", id, bytes, host, port));
  ipcMain.handle("p2p-native:open", (e) => (own(e) ? net.open() : Promise.reject(new Error("not allowed"))));
  ipcMain.on("p2p-native:send", (e, id, host, port, bytes, ttl) => {
    if (own(e) && bytes instanceof Uint8Array) net.send(id, host, port, bytes, ttl);
  });
  ipcMain.on("p2p-native:close", (e, id) => {
    if (own(e)) net.close(id);
  });
  ipcMain.handle("p2p-native:ssdp", (e, timeoutMs) => (own(e) ? net.ssdp(timeoutMs) : []));
  ipcMain.handle("p2p-native:http", (e, url, init) => (own(e) ? net.lanHttp(url, init) : Promise.reject(new Error("not allowed"))));
  app.on("window-all-closed", () => net.closeAll());
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  lockDown();
  nativeTransport();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
