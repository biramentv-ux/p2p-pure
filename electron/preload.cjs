/**
 * П4 (experiment): gives the page window.p2pNative (src/native/bridge.ts). Sandboxed preload:
 * only ipcRenderer and contextBridge, no Node. Every call goes to electron/nativeNet.mjs in the
 * main process, which accepts it only from the app's own page.
 */
const { contextBridge, ipcRenderer } = require("electron");

const handlers = new Set();
ipcRenderer.on("p2p-native:udp", (_e, id, bytes, host, port) => {
  for (const h of handlers) h(id, new Uint8Array(bytes), host, port);
});

contextBridge.exposeInMainWorld("p2pNative", {
  kind: "electron",
  udpOpen: () => ipcRenderer.invoke("p2p-native:open"),
  udpSend: (id, host, port, bytes, ttl) => ipcRenderer.send("p2p-native:send", id, host, port, bytes, ttl ?? 0),
  udpClose: (id) => ipcRenderer.send("p2p-native:close", id),
  onUdp: (h) => {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  ssdp: (timeoutMs) => ipcRenderer.invoke("p2p-native:ssdp", timeoutMs),
  lanHttp: (url, init) => ipcRenderer.invoke("p2p-native:http", url, init),
});
