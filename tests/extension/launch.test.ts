import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_URL, isMessengerOpen, openMessenger, openMessengerWindow } from "../../extension/launch.js";

type Chrome = Record<string, unknown>;
const mock = {
  tabs: { query: vi.fn(), update: vi.fn(), create: vi.fn() },
  windows: { update: vi.fn(), create: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { chrome: Chrome }).chrome = mock;
});

describe("launch", () => {
  it("reports whether a messenger tab is open", async () => {
    mock.tabs.query.mockResolvedValueOnce([{ id: 4, windowId: 2 }]);
    expect(await isMessengerOpen()).toBe(true);
    expect(mock.tabs.query).toHaveBeenCalledWith({ url: `${APP_URL}*` });

    mock.tabs.query.mockResolvedValueOnce([]);
    expect(await isMessengerOpen()).toBe(false);
  });

  it("brings an existing messenger tab forward instead of opening a second one", async () => {
    mock.tabs.query.mockResolvedValueOnce([{ id: 9, windowId: 3 }]);
    const out = await openMessenger();
    expect(out).toEqual({ tabId: 9, reused: true });
    expect(mock.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(mock.tabs.update).toHaveBeenCalledWith(9, { active: true });
    expect(mock.tabs.create).not.toHaveBeenCalled();
  });

  it("opens the messenger when no tab runs it", async () => {
    mock.tabs.query.mockResolvedValueOnce([]);
    mock.tabs.create.mockResolvedValueOnce({ id: 12 });
    const out = await openMessenger();
    expect(out).toEqual({ tabId: 12, reused: false });
    expect(mock.tabs.create).toHaveBeenCalledWith({ url: APP_URL });
  });

  it("opens a separate small window that is always new", async () => {
    mock.windows.create.mockResolvedValueOnce({ id: 77 });
    expect(await openMessengerWindow()).toEqual({ windowId: 77 });
    expect(mock.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: APP_URL, type: "popup", width: 420, height: 760, focused: true }),
    );
  });
});

describe("service worker", () => {
  it("opens the messenger on the shortcut and ignores other commands", async () => {
    let listener: ((command: string) => Promise<void>) | undefined;
    (globalThis as unknown as { chrome: Chrome }).chrome = {
      ...mock,
      commands: { onCommand: { addListener: (fn: typeof listener) => (listener = fn) } },
    };
    mock.tabs.query.mockResolvedValue([]);
    mock.tabs.create.mockResolvedValue({ id: 1 });

    await import("../../extension/service-worker.js");
    expect(listener).toBeTypeOf("function");

    await listener!("some-other-command");
    expect(mock.tabs.create).not.toHaveBeenCalled();

    await listener!("open-messenger");
    expect(mock.tabs.create).toHaveBeenCalledWith({ url: APP_URL });
  });
});
