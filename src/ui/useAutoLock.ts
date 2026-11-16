import { useEffect, useRef } from "react";
import { HIDE_GRACE_MS } from "./lockSettings";

/** Lock after this many milliseconds without input (the default; Settings can change it). */
export const AUTO_LOCK_MS = 10 * 60 * 1000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Calls onIdle once the person has given no input for `timeoutMs`. Any input restarts the
 * countdown. With `lockOnHide`, it also calls onIdle when the page has stayed hidden (another
 * app in front, screen off) for HIDE_GRACE_MS. Listeners are removed when the component
 * unmounts or the hook is disabled.
 */
export function useAutoLock(enabled: boolean, onIdle: () => void, timeoutMs = AUTO_LOCK_MS, lockOnHide = false): void {
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hidden: ReturnType<typeof setTimeout> | undefined;
    // Timers do not run while a phone suspends the page: on return, the clock decides.
    let lastInput = Date.now();
    let hiddenAt: number | null = null;
    const arm = () => {
      lastInput = Date.now();
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), timeoutMs);
    };
    const onVisibility = () => {
      if (hidden !== undefined) clearTimeout(hidden);
      hidden = undefined;
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        if (lockOnHide) hidden = setTimeout(() => onIdleRef.current(), HIDE_GRACE_MS);
        return;
      }
      const now = Date.now();
      const awayTooLong = lockOnHide && hiddenAt !== null && now - hiddenAt >= HIDE_GRACE_MS;
      hiddenAt = null;
      if (awayTooLong || now - lastInput >= timeoutMs) onIdleRef.current();
    };
    arm();
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, arm, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (hidden !== undefined) clearTimeout(hidden);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, arm);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, timeoutMs, lockOnHide]);
}
