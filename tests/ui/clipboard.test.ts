import { afterEach, describe, expect, it, vi } from "vitest";
import { copyWithAutoClear } from "../../src/ui/clipboard";

function fakeClipboard(initial = "") {
  let value = initial;
  return {
    get value() { return value; },
    writeText: vi.fn(async (text: string) => { value = text; }),
    readText: vi.fn(async () => value),
    set(text: string) { value = text; },
  };
}

afterEach(() => vi.useRealTimers());

describe("copyWithAutoClear", () => {
  it("writes the text right away", async () => {
    const cb = fakeClipboard();
    await copyWithAutoClear("p2p1:abc", cb, 1000);
    expect(cb.value).toBe("p2p1:abc");
  });

  it("clears the clipboard after the delay when it still holds our text", async () => {
    vi.useFakeTimers();
    const cb = fakeClipboard();
    await copyWithAutoClear("p2p1:abc", cb, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb.value).toBe("");
  });

  it("leaves the clipboard alone if the person copied something else", async () => {
    vi.useFakeTimers();
    const cb = fakeClipboard();
    await copyWithAutoClear("p2p1:abc", cb, 1000);
    cb.set("my own note");
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb.value).toBe("my own note");
  });

  it("does nothing when reading the clipboard is refused", async () => {
    vi.useFakeTimers();
    const cb = fakeClipboard();
    cb.readText.mockRejectedValueOnce(new Error("not allowed"));
    await copyWithAutoClear("p2p1:abc", cb, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb.value).toBe("p2p1:abc");
  });

  it("throws when there is no clipboard API", async () => {
    await expect(copyWithAutoClear("x", undefined, 1000)).rejects.toThrow();
  });
});
