import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backgroundLinkPlugin,
  refreshAndroidPermission,
  setBackgroundLinkEnabled,
  syncBackgroundLink,
} from "../../src/platform/mobile/backgroundLink";
import { notifyIncoming, permission } from "../../src/notify/notifier";

function fakeAndroid() {
  const calls: string[] = [];
  const plugin = {
    start: vi.fn(async () => void calls.push("start")),
    stop: vi.fn(async () => void calls.push("stop")),
    notify: vi.fn(async (o: { tag: string; title: string; body: string }) => void calls.push(`notify ${o.tag} ${o.title} ${o.body}`)),
    permission: vi.fn(async () => ({ state: "granted" })),
    askPermission: vi.fn(async () => ({ state: "granted" })),
    batterySettings: vi.fn(async () => undefined),
  };
  (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: { BackgroundLink: plugin } };
  return { plugin, calls };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).Capacitor;
  setBackgroundLinkEnabled(false);
});

describe("П3 Android keep-alive and notifications", () => {
  it("is absent in a browser and on iOS", () => {
    expect(backgroundLinkPlugin()).toBeNull();
    (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { BackgroundLink: {} } };
    expect(backgroundLinkPlugin()).toBeNull();
  });

  it("starts the service only when turned on and unlocked; stops it otherwise", async () => {
    const { calls } = fakeAndroid();
    const texts = { title: "T", text: "x" };
    expect(await syncBackgroundLink(true, texts)).toBe(false);
    setBackgroundLinkEnabled(true);
    expect(await syncBackgroundLink(true, texts)).toBe(true);
    expect(await syncBackgroundLink(false, texts)).toBe(false);
    expect(calls).toEqual(["stop", "start", "stop"]);
  });

  it("a message in the background becomes a native notification, without the text by default", async () => {
    const { calls } = fakeAndroid();
    await refreshAndroidPermission();
    expect(permission()).toBe("granted");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const d = notifyIncoming({ chatId: "chat:x", known: true, title: "Ани", preview: "тайна", hidden: "Ново съобщение" }, false, {
      enabled: true,
      sound: "none",
      volume: 0,
      showText: false,
    });
    expect(d.system).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain("notify chat:x Ани Ново съобщение");
    expect(calls.join()).not.toContain("тайна");
  });
});
