import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UnlockedIdentity } from "../../src/identity";
import { getActiveTurn, setActiveTurn, type TurnSettings as TurnValue } from "../../src/p2p/turnConfig";

const store = vi.hoisted(() => ({
  loadTurnSettings: vi.fn(),
  saveTurnSettings: vi.fn(),
  clearTurnSettings: vi.fn(),
}));
vi.mock("../../src/p2p/turnStore", () => store);

import { TurnSettings } from "../../src/ui/components/TurnSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const good: TurnValue = {
  enabled: true,
  url: "turns:turn.example.org:5349",
  username: "alice",
  credential: "s3cret",
  relayOnly: false,
};
const identity = { keyPair: { secretKey: new Uint8Array(32).fill(1) } } as unknown as UnlockedIdentity;

let root: Root | null = null;
let container: HTMLDivElement;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(TurnSettings, { identity })));
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((x) => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
}

beforeEach(() => {
  localStorage.setItem("p2p.lang", "bg");
  store.loadTurnSettings.mockResolvedValue(good);
  setActiveTurn(good);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
  setActiveTurn(null);
});

describe("TurnSettings busy state", () => {
  it("disables Save and Delete while a save is pending; Delete cannot start meanwhile", async () => {
    let finish!: (v: boolean) => void;
    store.saveTurnSettings.mockReturnValue(new Promise<boolean>((r) => (finish = r)));
    store.clearTurnSettings.mockResolvedValue(undefined);
    await mount();
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(button("Запази").disabled).toBe(true);
    expect(button("Изтрий релея").disabled).toBe(true);
    await act(async () => button("Изтрий релея").click());
    expect(store.clearTurnSettings).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(button("Запази").disabled).toBe(false);
    expect(button("Изтрий релея").disabled).toBe(false);
  });

  it("a save cancelled by the store reports no success", async () => {
    store.saveTurnSettings.mockResolvedValue(false);
    await mount();
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("TurnSettings delete", () => {
  it("on a failed delete: relay off in memory, error shown, no success message", async () => {
    store.clearTurnSettings.mockRejectedValue(new Error("idb blocked"));
    await mount();
    await act(async () => button("Изтрий релея").click());
    expect(getActiveTurn()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("не можа да бъде изтрит");
    expect(container.textContent).not.toContain("Релеят и данните му са изтрити.");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("on success: relay off, form cleared, success message", async () => {
    store.clearTurnSettings.mockResolvedValue(undefined);
    await mount();
    await act(async () => button("Изтрий релея").click());
    expect(getActiveTurn()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Релеят и данните му са изтрити.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    const url = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(url?.value).toBe("");
  });
});
