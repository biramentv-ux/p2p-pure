import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useAutoLock } from "../../src/ui/useAutoLock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(enabled: boolean, onIdle: () => void, timeoutMs: number) {
  function Probe() {
    useAutoLock(enabled, onIdle, timeoutMs);
    return null;
  }
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(createElement(Probe)));
  return () => act(() => root!.unmount());
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("useAutoLock", () => {
  it("fires once after the idle period", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    mount(true, onIdle, 1000);
    act(() => { vi.advanceTimersByTime(999); });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("input restarts the countdown", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    mount(true, onIdle, 1000);
    act(() => { vi.advanceTimersByTime(800); });
    act(() => { window.dispatchEvent(new Event("pointerdown")); });
    act(() => { vi.advanceTimersByTime(800); });
    expect(onIdle).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    mount(false, onIdle, 1000);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("removes its listeners on unmount", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const unmount = mount(true, onIdle, 1000);
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { window.dispatchEvent(new Event("keydown")); });
    expect(onIdle).not.toHaveBeenCalled();
  });
});
