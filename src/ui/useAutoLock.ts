import { useEffect, useRef } from "react";

/** Lock after this many milliseconds without input. */
export const AUTO_LOCK_MS = 10 * 60 * 1000;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

/**
 * Calls onIdle once the person has given no input for `timeoutMs`. Any input restarts the
 * countdown. Listeners are removed when the component unmounts or the hook is disabled.
 */
export function useAutoLock(enabled: boolean, onIdle: () => void, timeoutMs = AUTO_LOCK_MS): void {
  const onIdleRef = useRef(onIdle);
  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), timeoutMs);
    };
    arm();
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, arm, { passive: true });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, arm);
    };
  }, [enabled, timeoutMs]);
}
