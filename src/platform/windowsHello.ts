/**
 * Bridge to the desktop app's Windows Hello commands (src-tauri/src/windows_hello.rs).
 *
 * Only meaningful inside the Tauri shell on Windows. Everywhere else (browser PWA, Android,
 * iOS, Linux/Electron) `windowsHelloAvailable()` is false and the method stays hidden.
 * No @tauri-apps/api dependency: Tauri 2 always injects `__TAURI_INTERNALS__.invoke`.
 */

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauri(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === "function" ? internals : null;
}

/** True only in the Tauri desktop shell on Windows (does not say Hello is set up). */
export function isWindowsDesktopShell(): boolean {
  return tauri() !== null && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** Whether Windows Hello (face, fingerprint or PIN) can be used right now. Never throws. */
export async function windowsHelloAvailable(): Promise<boolean> {
  const t = tauri();
  if (!t || !isWindowsDesktopShell()) return false;
  try {
    return (await t.invoke("windows_hello_status")) === "available";
  } catch {
    return false;
  }
}

export class WindowsHelloError extends Error {
  /** "cancelled" | "unavailable" | "not-found" | "locked" | other text from Windows. */
  readonly reason: string;
  constructor(reason: string) {
    super(`Windows Hello: ${reason}`);
    this.name = "WindowsHelloError";
    this.reason = reason;
  }
}

/**
 * Signs a 32-byte challenge with the Hello key `credentialName` (created first when `create`).
 * Shows the Windows Hello prompt. Returns the deterministic RSA PKCS#1 v1.5 signature.
 */
export async function windowsHelloSign(
  credentialName: string,
  challenge: Uint8Array,
  create: boolean,
): Promise<Uint8Array> {
  const t = tauri();
  if (!t) throw new WindowsHelloError("unsupported");
  try {
    const out = await t.invoke("windows_hello_sign", {
      name: credentialName,
      challenge: Array.from(challenge),
      create,
    });
    if (!Array.isArray(out) || out.length < 128) throw new WindowsHelloError("bad-signature");
    return Uint8Array.from(out as number[]);
  } catch (err) {
    if (err instanceof WindowsHelloError) throw err;
    throw new WindowsHelloError(typeof err === "string" ? err : err instanceof Error ? err.message : "error");
  }
}
