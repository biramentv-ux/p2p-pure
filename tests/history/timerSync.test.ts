import { describe, expect, it, vi } from "vitest";
import { TimerSync } from "../../src/history/timerSync";
import { DAY, HOUR } from "../../src/history/disappearing";

describe("TimerSync", () => {
  it("applies a chosen value only after it was sent", async () => {
    const persist = vi.fn(async () => undefined);
    const t = new TimerSync(null, { persist, now: () => 100 });
    await expect(t.choose(HOUR, async () => Promise.reject(new Error("offline")))).rejects.toThrow();
    expect(t.ms).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(await t.choose(HOUR, async () => undefined)).toBe(true);
    expect(t.current()).toEqual({ ms: HOUR, at: 100 });
    expect(await t.choose(HOUR, async () => undefined)).toBe(false);
    expect(await t.choose(123, async () => undefined)).toBe(false);
  });

  it("two sides that choose at once end on the same value", async () => {
    let now = 50;
    const a = new TimerSync(null, { persist: async () => undefined, now: () => now });
    const b = new TimerSync(null, { persist: async () => undefined, now: () => now });
    const sentA: { ms: number; at: number }[] = [];
    const sentB: { ms: number; at: number }[] = [];
    await a.choose(HOUR, async (s) => void sentA.push(s));
    await b.choose(DAY, async (s) => void sentB.push(s));
    await a.receive(sentB[0]);
    await b.receive(sentA[0]);
    expect(a.current()).toEqual(b.current());
    expect(a.ms).toBe(HOUR); // equal time: the shorter timer wins
    now = 60;
    expect(await a.receive({ ms: DAY, at: 10 })).toBe("kept-ours");
    expect(await a.receive({ ms: DAY, at: 70 })).toBe("changed-value");
  });

  it("a newer setting that arrives while ours is being sent wins over ours", async () => {
    const t = new TimerSync(null, { persist: async () => undefined, now: () => 100 });
    const changed = await t.choose(HOUR, async () => {
      expect(await t.receive({ ms: DAY, at: 101 })).toBe("changed-value");
    });
    expect(changed).toBe(false);
    expect(t.current()).toEqual({ ms: DAY, at: 101 });
    // An older one arriving meanwhile does not stop ours.
    const u = new TimerSync(null, { persist: async () => undefined, now: () => 100 });
    expect(await u.choose(HOUR, async () => void (await u.receive({ ms: DAY, at: 50 })))).toBe(true);
    expect(u.current()).toEqual({ ms: HOUR, at: 100 });
  });

  it("gives the expiry under the current timer", async () => {
    const t = new TimerSync({ ms: HOUR, at: 1 }, { persist: async () => undefined });
    expect(t.expiryFor(1000)).toBe(1000 + HOUR);
    const off = new TimerSync({ ms: 5, at: 1 }, { persist: async () => undefined });
    expect(off.expiryFor(1000)).toBeUndefined();
  });
});
