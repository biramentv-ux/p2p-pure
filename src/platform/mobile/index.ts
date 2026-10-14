import { createWebBridge } from "./webBridge";
import type { MobileBridge } from "./types";

export type { MobileBridge, PlatformInfo, PlatformKind } from "./types";
export { resolveRpId, detectKind, createWebBridge } from "./webBridge";
export { nativePasskeys, type PasskeyBridgePlugin } from "./nativePasskeys";
export { creationOptionsToJson, requestOptionsToJson, parseCredentialResponse } from "./passkeyJson";

let bridge: MobileBridge = createWebBridge();

/** The active bridge. Tests and native overlays can swap it. */
export function getMobileBridge(): MobileBridge {
  return bridge;
}

export function setMobileBridge(next: MobileBridge): void {
  bridge = next;
}
