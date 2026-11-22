/**
 * П6 (experiment): Tor from the shell, the same Arti code (src-tauri/src/tor_net.rs) in both:
 *  - the Tauri desktop app built with `--features tor-transport` (commands tor_*);
 *  - the Android app when its APK carries libp2ptor.so (TorPlugin, built by
 *    .github/workflows/android-tor.yml). Without the library the plugin says "unavailable".
 * In a browser there is none.
 */
export interface TorEvent {
  id: number;
  kind: "open" | "data" | "close";
  data?: Uint8Array;
  incoming?: boolean;
}

export interface TorBridge {
  start(): Promise<string>;
  connect(onion: string): Promise<number>;
  send(id: number, bytes: Uint8Array): Promise<void>;
  close(id: number): void;
  onEvent(h: (e: TorEvent) => void): () => void;
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Windowish {
  __TAURI_INTERNALS__?: { invoke: Invoke };
  Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> };
}

interface TorPluginApi {
  status(): Promise<{ started: boolean; onion?: string }>;
  start(): Promise<{ onion: string }>;
  connect(o: { onion: string }): Promise<{ id: number }>;
  send(o: { id: number; data: string }): Promise<void>;
  close(o: { id: number }): Promise<void>;
  recv(o: { waitMs: number }): Promise<{ events: Array<{ id: number; kind: TorEvent["kind"]; data?: string; incoming?: boolean }> }>;
}

/** The Android plugin as the same command interface the desktop has. */
function androidInvoke(p: TorPluginApi): Invoke {
  return async (cmd, args = {}) => {
    switch (cmd) {
      case "tor_status":
        return p.status();
      case "tor_start":
        return (await p.start()).onion;
      case "tor_connect":
        return (await p.connect({ onion: String(args.onion) })).id;
      case "tor_send":
        return p.send({ id: Number(args.id), data: String(args.data) });
      case "tor_close":
        return p.close({ id: Number(args.id) });
      case "tor_recv":
        return (await p.recv({ waitMs: Number(args.waitMs ?? 500) })).events;
      default:
        throw new Error(`unknown ${cmd}`);
    }
  };
}

const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let cached: TorBridge | null | undefined;

/** The Tor bridge, or null when the shell has none. Asks the shell once. */
export async function torBridge(win: Windowish = globalThis as unknown as Windowish): Promise<TorBridge | null> {
  if (cached !== undefined && win === (globalThis as unknown)) return cached;
  let found: TorBridge | null = null;
  const plugin = win.Capacitor?.isNativePlatform?.() ? (win.Capacitor.Plugins?.Tor as TorPluginApi | undefined) : undefined;
  const invoke = win.__TAURI_INTERNALS__?.invoke ?? (plugin ? androidInvoke(plugin) : undefined);
  if (invoke) {
    // Builds without the feature do not know the command: then there is no Tor.
    const ok = await invoke("tor_status").then(
      () => true,
      () => false,
    );
    if (ok) found = tauriTor(invoke);
  }
  if (win === (globalThis as unknown)) cached = found;
  return found;
}

function tauriTor(invoke: Invoke): TorBridge {
  const handlers = new Set<(e: TorEvent) => void>();
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    while (handlers.size > 0) {
      const batch = (await invoke("tor_recv", { waitMs: 500 }).catch(() => [])) as Array<{ id: number; kind: TorEvent["kind"]; data?: string; incoming?: boolean }>;
      for (const e of batch) {
        const ev: TorEvent = { id: e.id, kind: e.kind, incoming: e.incoming, data: e.data ? fromB64(e.data) : undefined };
        for (const h of handlers) h(ev);
      }
    }
    polling = false;
  };
  return {
    start: async () => (await invoke("tor_start")) as string,
    connect: async (onion) => (await invoke("tor_connect", { onion })) as number,
    send: async (id, bytes) => void (await invoke("tor_send", { id, data: toB64(bytes) })),
    close: (id) => void invoke("tor_close", { id }).catch(() => undefined),
    onEvent: (h) => {
      handlers.add(h);
      void poll();
      return () => handlers.delete(h);
    },
  };
}
