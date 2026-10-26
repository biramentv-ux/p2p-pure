import { describe, it, expect, afterEach } from "vitest";
import { getSignalMode, setSignalMode } from "../../src/signaling/mode";

afterEach(() => {
  localStorage.clear();
});

describe("signal mode", () => {
  it("defaults to local when nothing is stored", () => {
    expect(getSignalMode()).toBe("local");
  });

  it("remembers the demo choice", () => {
    setSignalMode("demo");
    expect(getSignalMode()).toBe("demo");
    setSignalMode("local");
    expect(getSignalMode()).toBe("local");
  });

  it("falls back to local when storage throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(getSignalMode()).toBe("local");
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});
