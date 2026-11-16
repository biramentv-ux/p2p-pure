import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IDBFactory } from "fake-indexeddb";
import { DEFAULT_LOCK, HIDE_GRACE_MS, loadLockSettings, saveLockSettings } from "../../src/ui/lockSettings";
import { useAutoLock } from "../../src/ui/useAutoLock";
import { clearAppSettings, panicWipe } from "../../src/security/panic";
import { STORE_IDENTITY, STORE_MESSAGES, openDatabase, withStore } from "../../src/db/database";
import { FileResumeStore, parkedFiles } from "../../src/p2p/fileTransfer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

describe("lock settings", () => {
  it("round-trip, and anything unknown falls back to the default", () => {
    const s = memory();
    expect(loadLockSettings(s)).toEqual(DEFAULT_LOCK);
    saveLockSettings({ minutes: 1, onHide: true }, s);
    expect(loadLockSettings(s)).toEqual({ minutes: 1, onHide: true });
    s.setItem("p2p.lock", JSON.stringify({ minutes: 7, onHide: "yes" }));
    expect(loadLockSettings(s)).toEqual(DEFAULT_LOCK);
    s.setItem("p2p.lock", "{");
    expect(loadLockSettings(s)).toEqual(DEFAULT_LOCK);
  });
});

describe("lock when hidden", () => {
  let root: Root | null = null;
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    hidden = false;
    vi.useRealTimers();
  });
  function mount(onHide: boolean, onIdle: () => void) {
    function Probe() {
      useAutoLock(true, onIdle, 60 * 60 * 1000, onHide);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Probe)));
  }
  const setHidden = (v: boolean) =>
    act(() => {
      hidden = v;
      document.dispatchEvent(new Event("visibilitychange"));
    });

  it("locks after the grace period in the background, not before", () => {
    const onIdle = vi.fn();
    mount(true, onIdle);
    setHidden(true);
    act(() => void vi.advanceTimersByTime(HIDE_GRACE_MS - 1));
    expect(onIdle).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("coming back in time cancels it, and it is off unless chosen", () => {
    const onIdle = vi.fn();
    mount(true, onIdle);
    setHidden(true);
    act(() => void vi.advanceTimersByTime(HIDE_GRACE_MS / 2));
    setHidden(false);
    act(() => void vi.advanceTimersByTime(HIDE_GRACE_MS * 2));
    expect(onIdle).not.toHaveBeenCalled();

    act(() => root!.unmount());
    root = null;
    const off = vi.fn();
    mount(false, off);
    setHidden(true);
    act(() => void vi.advanceTimersByTime(HIDE_GRACE_MS * 2));
    expect(off).not.toHaveBeenCalled();
  });
});

describe("panic wipe", () => {
  beforeEach(() => {
    // @ts-expect-error - a fresh in-memory database for every test
    globalThis.indexedDB = new IDBFactory();
  });

  it("removes this app's settings but keeps the language and other sites' keys", () => {
    const s = memory({ "p2p.lang": "en", "p2p.lock": "{}", "p2p.notify": "{}", "p2p-signal-mode": "x", other: "1" });
    clearAppSettings(s);
    expect(s.keys().sort()).toEqual(["other", "p2p.lang"]);
  });

  it("empties every store, stops the writers first and forgets paused files", async () => {
    await withStore(STORE_IDENTITY, "readwrite", (st) => void st.put({ did: "x" }, "current"));
    await withStore(STORE_MESSAGES, "readwrite", (st) => void st.put({ id: "m", peerDid: "p" }));
    const order: string[] = [];
    const writer = { closeAll: () => void order.push("close"), flush: async () => void order.push("flush") };
    const spy = vi.spyOn(parkedFiles, "clear");
    await panicWipe([writer, null]);
    expect(order).toEqual(["close", "flush"]);
    expect(spy).toHaveBeenCalled();
    const db = await openDatabase();
    try {
      for (const name of Array.from(db.objectStoreNames)) {
        const count = await new Promise<number>((resolve) => {
          const req = db.transaction(name).objectStore(name).count();
          req.onsuccess = () => resolve(req.result);
        });
        expect(count, name).toBe(0);
      }
    } finally {
      db.close();
    }
    spy.mockRestore();
  });

  it("a cleared resume store zeroes the keys it held", () => {
    const store = new FileResumeStore();
    const key = new Uint8Array(32).fill(7);
    const meta = { id: "AAAAAAAAAAA", name: "x", size: 1, mime: "application/octet-stream", sha256: "" };
    store.park("p", [{ meta, rawId: new Uint8Array(8), key, blob: new Blob(["x"]), next: 0 }], []);
    store.clear();
    expect(key.every((b) => b === 0)).toBe(true);
    expect(store.count("p")).toBe(0);
  });
});

describe("lock when the page was suspended", () => {
  let root: Root | null = null;
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    hidden = false;
    vi.useRealTimers();
  });
  function mount(onHide: boolean, onIdle: () => void, timeout = 60 * 60 * 1000) {
    function Probe() {
      useAutoLock(true, onIdle, timeout, onHide);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(createElement(Probe)));
  }
  const setHidden = (v: boolean) =>
    act(() => {
      hidden = v;
      document.dispatchEvent(new Event("visibilitychange"));
    });

  it("locks on return when the background time passed but the timer never ran", () => {
    const onIdle = vi.fn();
    mount(true, onIdle);
    setHidden(true);
    // The phone froze the page: the clock moves, no timer fires.
    vi.setSystemTime(Date.now() + HIDE_GRACE_MS + 5000);
    setHidden(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("locks on return when the inactivity time passed while suspended (lock on hide off)", () => {
    const onIdle = vi.fn();
    mount(false, onIdle, 60_000);
    setHidden(true);
    vi.setSystemTime(Date.now() + 61_000);
    setHidden(false);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
