/**
 * П4 (experiment): what the native shells give the web app for the native transport. A browser
 * (the PWA) has none of this: no UDP sockets, no way to talk to the router (Direct Sockets exist
 * only for Isolated Web Apps). Then `nativeBridge()` is null and nothing native ever runs.
 *
 *  - Electron (Linux): window.p2pNative from electron/preload.cjs → electron/nativeNet.mjs.
 *  - Tauri (Windows): commands from src-tauri/src/native_net.rs, built with the
 *    "native-transport" feature only.
 *  - Android (Capacitor): the NativeNet plugin (android/.../NativeNetPlugin.java).
 *
 * The protocol work (STUN, punching, the encrypted link, port-mapping messages) stays in the
 * web code (src/native/*.ts), the same for all three; the shells only move datagrams and make
 * one kind of HTTP request (SOAP to the router on the LAN).
 */
import type { PunchSocket } from "./punch";

export interface NativeBridge {
  readonly kind: "electron" | "tauri" | "android";
  udpOpen(): Promise<{ id: number; port: number; lanAddress?: string }>;
  udpSend(id: number, host: string, port: number, bytes: Uint8Array, ttl?: number): void;
  udpClose(id: number): void;
  /** Every datagram that arrives on any open socket. */
  onUdp(handler: (id: number, bytes: Uint8Array, host: string, port: number) => void): () => void;
  /** SSDP search on the LAN: the raw answers (the web code picks and checks the location). */
  ssdp(timeoutMs: number): Promise<string[]>;
  /** HTTP to a router on the LAN (private address only): GET a description or POST a SOAP call. */
  lanHttp(url: string, init: { method: "GET" | "POST"; soapAction?: string; body?: string }): Promise<{ status: number; text: string }>;
}

interface Windowish {
  p2pNative?: NativeBridge;
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
}

let cached: NativeBridge | null | undefined;

/** The shell's bridge, or null in a browser. */
export function nativeBridge(win: Windowish = globalThis as unknown as Windowish): NativeBridge | null {
  if (cached !== undefined && win === (globalThis as unknown)) return cached;
  let found: NativeBridge | null = null;
  if (win.p2pNative && win.p2pNative.kind === "electron") found = win.p2pNative;
  else if (win.__TAURI_INTERNALS__?.invoke) found = tauriBridge(win.__TAURI_INTERNALS__.invoke);
  else if (win.Capacitor?.isNativePlatform?.() && win.Capacitor.Plugins?.NativeNet) found = capacitorBridge(win.Capacitor.Plugins.NativeNet as CapacitorNativeNet);
  if (win === (globalThis as unknown)) cached = found;
  return found;
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Tauri: commands, and datagrams fetched in batches (no event plumbing in the shell). */
function tauriBridge(invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): NativeBridge {
  const handlers = new Set<(id: number, bytes: Uint8Array, host: string, port: number) => void>();
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    while (handlers.size > 0) {
      const batch = (await invoke("native_udp_recv", { waitMs: 200 }).catch(() => [])) as Array<{ id: number; data: string; host: string; port: number }>;
      for (const d of batch) for (const h of handlers) h(d.id, fromB64(d.data), d.host, d.port);
    }
    polling = false;
  };
  return {
    kind: "tauri",
    udpOpen: async () => (await invoke("native_udp_open")) as { id: number; port: number; lanAddress?: string },
    udpSend: (id, host, port, bytes, ttl) => void invoke("native_udp_send", { id, host, port, data: toB64(bytes), ttl: ttl ?? 0 }).catch(() => undefined),
    udpClose: (id) => void invoke("native_udp_close", { id }).catch(() => undefined),
    onUdp: (h) => {
      handlers.add(h);
      void poll();
      return () => handlers.delete(h);
    },
    ssdp: async (timeoutMs) => (await invoke("native_ssdp", { timeoutMs })) as string[],
    lanHttp: async (url, init) => (await invoke("native_lan_http", { url, method: init.method, soapAction: init.soapAction ?? "", body: init.body ?? "" })) as { status: number; text: string },
  };
}

interface CapacitorNativeNet {
  open(): Promise<{ id: number; port: number; lanAddress?: string }>;
  send(o: { id: number; host: string; port: number; data: string; ttl: number }): Promise<void>;
  close(o: { id: number }): Promise<void>;
  addListener(ev: "datagram", h: (d: { id: number; data: string; host: string; port: number }) => void): Promise<{ remove: () => void }>;
  ssdp(o: { timeoutMs: number }): Promise<{ locations: string[] }>;
  lanHttp(o: { url: string; method: string; soapAction: string; body: string }): Promise<{ status: number; text: string }>;
}

function capacitorBridge(p: CapacitorNativeNet): NativeBridge {
  return {
    kind: "android",
    udpOpen: () => p.open(),
    udpSend: (id, host, port, bytes, ttl) => void p.send({ id, host, port, data: toB64(bytes), ttl: ttl ?? 0 }).catch(() => undefined),
    udpClose: (id) => void p.close({ id }).catch(() => undefined),
    onUdp: (h) => {
      const sub = p.addListener("datagram", (d) => h(d.id, fromB64(d.data), d.host, d.port));
      return () => void sub.then((s) => s.remove());
    },
    ssdp: async (timeoutMs) => (await p.ssdp({ timeoutMs })).locations,
    lanHttp: (url, init) => p.lanHttp({ url, method: init.method, soapAction: init.soapAction ?? "", body: init.body ?? "" }),
  };
}

/** A socket of the bridge as the punching code wants it. */
export async function bridgeSocket(bridge: NativeBridge): Promise<PunchSocket & { lanAddress?: string }> {
  const { id, port, lanAddress } = await bridge.udpOpen();
  const handlers = new Set<(b: Uint8Array, port: number, host: string) => void>();
  const off = bridge.onUdp((sid, bytes, host, p) => {
    if (sid === id) for (const h of handlers) h(bytes, p, host);
  });
  return {
    localPort: port,
    lanAddress,
    send: (bytes, p, host, ttl) => bridge.udpSend(id, host, p, bytes, ttl),
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    close: () => {
      off();
      bridge.udpClose(id);
    },
  };
}
