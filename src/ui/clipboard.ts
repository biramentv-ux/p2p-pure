/**
 * Copies text and clears it again after a delay, so an invitation does not stay on
 * the clipboard for other apps to read. The clipboard is cleared only if it still holds
 * exactly what we copied; if the person copied something else meanwhile, it is left alone.
 * If the browser refuses to read the clipboard, nothing is cleared (we cannot tell).
 */
export const CLIPBOARD_CLEAR_MS = 60_000;

export async function copyWithAutoClear(
  text: string,
  clipboard: Pick<Clipboard, "writeText" | "readText"> | undefined = globalThis.navigator?.clipboard,
  delayMs = CLIPBOARD_CLEAR_MS,
): Promise<void> {
  if (!clipboard) throw new Error("clipboard unavailable");
  await clipboard.writeText(text);
  setTimeout(async () => {
    try {
      if ((await clipboard.readText()) === text) await clipboard.writeText("");
    } catch {
      // Reading is not allowed here; leave the clipboard as it is.
    }
  }, delayMs);
}
