/**
 * JS side of the Android Credential Manager bridge (native plugin "PasskeyBridge",
 * implemented in native-overlays/android/PasskeyBridgePlugin.java).
 *
 * On the web, or on iOS, nativePasskeys() returns null and the app uses
 * navigator.credentials as before.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface PasskeyBridgePlugin {
  create(options: { requestJson: string }): Promise<{ responseJson: string }>;
  get(options: { requestJson: string }): Promise<{ responseJson: string }>;
}

let cached: PasskeyBridgePlugin | null | undefined;

export function nativePasskeys(): PasskeyBridgePlugin | null {
  if (cached !== undefined) return cached;
  const isAndroid = Capacitor.getPlatform() === "android";
  cached = isAndroid && Capacitor.isPluginAvailable("PasskeyBridge")
    ? registerPlugin<PasskeyBridgePlugin>("PasskeyBridge")
    : null;
  return cached;
}

/** Test hook: forget the cached plugin lookup. */
export function resetNativePasskeysForTests(): void {
  cached = undefined;
}
