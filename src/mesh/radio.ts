/**
 * П5 (experiment): the router on the Android radio (MeshRadioPlugin). Pieces in, packets out,
 * the rotating id refreshed at each 15-minute boundary. Only in the Android app, only with the
 * experiment on; nothing here runs in a browser.
 */
import { RotatingId } from "./addressing";
import { fragment, Reassembler } from "./fragment";
import { MeshRouter, type MeshRouterOptions } from "./router";
import { bytesToBase64Url } from "../p2p/encoding";

const SETTING_KEY = "p2p-mesh-experiment";

export function meshEnabled(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMeshEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(SETTING_KEY, "1");
    else localStorage.removeItem(SETTING_KEY);
  } catch {
    /* private mode: stays off */
  }
}

interface Listener {
  remove(): void;
}

export interface MeshRadioPlugin {
  start(o: { rotatingId: string }): Promise<{ aware: boolean }>;
  stop(): Promise<void>;
  setRotatingId(o: { rotatingId: string }): Promise<void>;
  send(o: { to: string; data: string }): Promise<void>;
  addListener(ev: "peer", h: (d: { id: string; via: "ble" | "aware"; up: boolean }) => void): Promise<Listener>;
  addListener(ev: "piece", h: (d: { from: string; data: string }) => void): Promise<Listener>;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The plugin when running in the Android app, else null. */
export function meshRadioPlugin(win: { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } } = globalThis as never): MeshRadioPlugin | null {
  if (!win.Capacitor?.isNativePlatform?.()) return null;
  return (win.Capacitor.Plugins?.MeshRadio as MeshRadioPlugin | undefined) ?? null;
}

/** Starts the radio and wires it to a router. Returns stop(). */
export async function startMeshRadio(plugin: MeshRadioPlugin, o: Omit<MeshRouterOptions, "send">): Promise<{ router: MeshRouter; stop: () => Promise<void> }> {
  const mtu: Record<string, number> = {};
  const parts = new Map<string, Reassembler>();
  const router = new MeshRouter({
    ...o,
    send: (to, bytes) => {
      for (const piece of fragment(bytes, mtu[to] ?? 180)) void plugin.send({ to, data: b64(piece) }).catch(() => undefined);
    },
  });
  const rotating = new RotatingId(o.now);
  const subs = [
    await plugin.addListener("peer", (d) => {
      if (d.up) {
        mtu[d.id] = d.via === "aware" ? 250 : 180;
        router.addNeighbour(d.id);
      } else {
        router.removeNeighbour(d.id);
        parts.delete(d.id);
      }
    }),
    await plugin.addListener("piece", (d) => {
      let r = parts.get(d.from);
      if (!r) parts.set(d.from, (r = new Reassembler(o.now)));
      const whole = r.push(unb64(d.data));
      if (whole) router.receive(d.from, whole);
    }),
  ];
  await plugin.start({ rotatingId: b64(rotating.current()) });
  let timer: ReturnType<typeof setTimeout>;
  const rotate = () => {
    timer = setTimeout(() => {
      void plugin.setRotatingId({ rotatingId: b64(rotating.current()) }).catch(() => undefined);
      rotate();
    }, rotating.msToRotation() + 50);
  };
  rotate();
  return {
    router,
    stop: async () => {
      clearTimeout(timer);
      for (const s of subs) s.remove();
      await plugin.stop();
    },
  };
}

/** For logs and the docs: a short, non-identifying label of a packet id. */
export function shortId(id: Uint8Array): string {
  return bytesToBase64Url(id).slice(0, 6);
}
