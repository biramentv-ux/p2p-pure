/**
 * One chat's disappearing-messages timer, without React: the 1:1 chat (useDisappearingTimer)
 * and the group session use the same rules (history/disappearing.ts).
 *
 *  - choose(): a person changes it. The new setting is sent first; only a setting that left
 *    is applied, so nobody keeps a timer the other side never heard of.
 *  - receive(): a setting from the other side (or sides) is kept only if newerTimer() picks it,
 *    so every device ends on the same winner whatever the order of arrival.
 *  - current(): what to announce when a chat opens.
 */
import { expiryFor, newerTimer, validDisappearMs, type TimerSetting } from "./disappearing";

export interface TimerSyncOptions {
  /** Stores a new winning setting (the contact book, the group record). */
  persist: (setting: TimerSetting) => Promise<void>;
  /** Called after every change of the setting in memory (re-render, notices). */
  onChange?: (setting: TimerSetting) => void;
  now?: () => number;
}

export type ReceiveResult = "kept-ours" | "changed-time" | "changed-value";

export class TimerSync {
  private setting: TimerSetting;
  private readonly o: TimerSyncOptions;

  constructor(initial: Partial<TimerSetting> | null | undefined, options: TimerSyncOptions) {
    this.setting = { ms: validDisappearMs(initial?.ms) ?? 0, at: typeof initial?.at === "number" && initial.at > 0 ? initial.at : 0 };
    this.o = options;
  }

  current(): TimerSetting {
    return { ...this.setting };
  }

  get ms(): number {
    return this.setting.ms;
  }

  /** When a message written at `timestamp` expires under the current timer. */
  expiryFor(timestamp: number): number | undefined {
    return expiryFor(timestamp, this.setting.ms);
  }

  /**
   * The person picked `ms`. `send` must deliver the setting or throw. Returns false when nothing
   * changed, or when a newer setting arrived during the send and won.
   */
  async choose(ms: number, send: (setting: TimerSetting) => Promise<void>): Promise<boolean> {
    const value = validDisappearMs(ms);
    if (value === null || value === this.setting.ms) return false;
    const now = (this.o.now ?? Date.now)();
    const next: TimerSetting = { ms: value, at: Math.max(now, this.setting.at + 1) };
    await send(next);
    // A newer setting from someone else may have arrived while ours was on its way: the same
    // rule as receive() decides, so every device still ends on the same winner.
    const winner = newerTimer(this.setting, next);
    if (winner.ms !== next.ms || winner.at !== next.at) return false;
    await this.apply(next);
    return true;
  }

  /** A setting from the other side. */
  async receive(incoming: TimerSetting): Promise<ReceiveResult> {
    const mine = this.setting;
    const winner = newerTimer(mine, incoming);
    if (winner.ms === mine.ms && winner.at === mine.at) return "kept-ours";
    await this.apply(winner);
    return winner.ms === mine.ms ? "changed-time" : "changed-value";
  }

  private async apply(setting: TimerSetting): Promise<void> {
    this.setting = { ...setting };
    this.o.onChange?.(this.current());
    await this.o.persist(this.current()).catch(() => undefined);
  }
}
