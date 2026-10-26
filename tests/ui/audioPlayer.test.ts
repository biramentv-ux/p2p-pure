import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AudioPlayer } from "../../src/ui/components/AudioPlayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(name = "song.mp3", autoPlay = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(AudioPlayer, { src: "blob:test", name, autoPlay })));
  return host;
}
const button = (label: RegExp) =>
  [...host!.querySelectorAll("button")].find((b) => label.test(b.getAttribute("aria-label") ?? ""))!;

beforeEach(() => {
  // jsdom has no media engine.
  const state = new WeakMap<HTMLMediaElement, boolean>();
  Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get(this: HTMLMediaElement) { return !state.get(this); } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    state.set(this, true);
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    state.set(this, false);
    this.dispatchEvent(new Event("pause"));
  });
});
afterEach(() => {
  // Players share one volume; put it back for the next test.
  if (root) for (let i = 0; i < 12; i++) act(() => button(/По-силно|Volume up/)?.click());
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("AudioPlayer", () => {
  it("plays and pauses", () => {
    mount();
    const play = button(/Пусни|Play/);
    act(() => play.click());
    expect(button(/Пауза|Pause/)).toBeTruthy();
    act(() => button(/Пауза|Pause/).click());
    expect(button(/Пусни|Play/)).toBeTruthy();
  });

  it("changes the volume in steps of 10% and stops at the ends", () => {
    mount();
    const el = host!.querySelector("audio")!;
    expect(el.volume).toBe(1);
    act(() => button(/По-тихо|Volume down/).click());
    act(() => button(/По-тихо|Volume down/).click());
    expect(el.volume).toBeCloseTo(0.8, 5);
    expect(host!.textContent).toMatch(/80%/);
    for (let i = 0; i < 12; i++) act(() => button(/По-тихо|Volume down/).click());
    expect(el.volume).toBe(0);
    expect((button(/По-тихо|Volume down/) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 12; i++) act(() => button(/По-силно|Volume up/).click());
    expect(el.volume).toBe(1);
    expect((button(/По-силно|Volume up/) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a volume change reaches every player already on the screen", () => {
    mount("one.mp3");
    const second = document.createElement("div");
    document.body.append(second);
    const root2 = createRoot(second);
    act(() => root2.render(createElement(AudioPlayer, { src: "blob:two", name: "two.mp3" })));
    for (let i = 0; i < 5; i++) act(() => button(/По-тихо|Volume down/).click());
    expect(host!.querySelector("audio")!.volume).toBeCloseTo(0.5, 5);
    expect(second.querySelector("audio")!.volume).toBeCloseTo(0.5, 5);
    expect(second.textContent).toMatch(/50%/);
    act(() => root2.unmount());
    second.remove();
  });

  it("keeps a download link, also when the sound cannot be played", () => {
    mount("odd.mp3");
    const link = () => host!.querySelector<HTMLAnchorElement>("a.file-download");
    expect(link()?.getAttribute("download")).toBe("odd.mp3");
    act(() => {
      host!.querySelector("audio")!.dispatchEvent(new Event("error"));
    });
    expect(host!.textContent).toMatch(/не може да се пусне|cannot be played/);
    expect(link()?.getAttribute("href")).toBe("blob:test");
  });

  it("starts a second track only after stopping the first", () => {
    mount("one.mp3");
    const first = host!.querySelector("audio")!;
    act(() => button(/Пусни|Play/).click());
    const second = document.createElement("div");
    document.body.append(second);
    const root2 = createRoot(second);
    act(() => root2.render(createElement(AudioPlayer, { src: "blob:two", name: "two.mp3", autoPlay: true })));
    expect(first.paused).toBe(true);
    act(() => root2.unmount());
    second.remove();
  });
});
