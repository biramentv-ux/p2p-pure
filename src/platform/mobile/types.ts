/**
 * What the web code needs to know about where it runs. The React/TypeScript
 * core stays the same everywhere; native code is added only for things the web
 * platform cannot do safely on its own (see native-overlays/).
 */
export type PlatformKind = "web" | "ios" | "android";

export interface PlatformInfo {
  kind: PlatformKind;
  /** True inside the Capacitor shell (iOS or Android), false in a normal browser. */
  isNative: boolean;
  /** Host the page is served from, e.g. "dyrakarmy.online" or "localhost". */
  hostname: string;
}

/** Everything the app asks the platform layer. A native overlay can replace the web implementation. */
export interface MobileBridge {
  info(): PlatformInfo;
  /** rpId to use for WebAuthn on this platform. */
  passkeyRpId(): string;
}
