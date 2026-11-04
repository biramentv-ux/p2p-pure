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

  it("remembers the Bluetooth choice and ignores unknown values", () => {
    setSignalMode("ble");
    expect(getSignalMode()).toBe("ble");
    localStorage.setItem("p2p-signal-mode", "carrier-pigeon");
    expect(getSignalMode()).toBe("local");
  });

  it("remembers the sound choice", () => {
    setSignalMode("sound");
    expect(getSignalMode()).toBe("sound");
    localStorage.setItem("p2p-signal-mode", "Sound");
    expect(getSignalMode()).toBe("local");
  });

  it("remembers the light choice", () => {
    setSignalMode("light");
    expect(getSignalMode()).toBe("light");
    localStorage.setItem("p2p-signal-mode", "Light");
    expect(getSignalMode()).toBe("local");
    localStorage.setItem("p2p-signal-mode", "light ");
    expect(getSignalMode()).toBe("local");
  });

  it("switches between sound and light", () => {
    setSignalMode("sound");
    setSignalMode("light");
    expect(getSignalMode()).toBe("light");
    setSignalMode("sound");
    expect(getSignalMode()).toBe("sound");
  });

  it("does not throw when storage refuses to save", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      expect(() => setSignalMode("sound")).not.toThrow();
      expect(() => setSignalMode("light")).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
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
