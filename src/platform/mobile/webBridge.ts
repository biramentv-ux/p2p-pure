import { Capacitor } from "@capacitor/core";
import type { MobileBridge, PlatformInfo, PlatformKind } from "./types";

/**
 * WebAuthn only accepts an rpId that equals the page's host or is a registrable
 * parent of it. A configured rpId that does not fit would make every passkey call
 * fail with a SecurityError, so it is ignored and the host itself is used.
 */
export function resolveRpId(hostname: string, configured?: string): string {
  const wanted = configured?.trim().toLowerCase();
  const host = hostname.toLowerCase();
  if (!wanted) return host;
  if (host === wanted || host.endsWith(`.${wanted}`)) return wanted;
  return host;
}

export function detectKind(capacitorPlatform: string | undefined): PlatformKind {
  return capacitorPlatform === "ios" || capacitorPlatform === "android" ? capacitorPlatform : "web";
}

/** Optional override, set at build time: VITE_PASSKEY_RP_ID=dyrakarmy.online */
function configuredRpId(): string | undefined {
  const value = (import.meta.env as Record<string, string | undefined>).VITE_PASSKEY_RP_ID;
  return value || undefined;
}

export function createWebBridge(
  getPlatform: () => string | undefined = () => Capacitor.getPlatform(),
  getHostname: () => string = () => (typeof window !== "undefined" ? window.location.hostname : "localhost"),
  getConfiguredRpId: () => string | undefined = configuredRpId,
): MobileBridge {
  return {
    info(): PlatformInfo {
      const kind = detectKind(getPlatform());
      return { kind, isNative: kind !== "web", hostname: getHostname() };
    },
    passkeyRpId(): string {
      const kind = detectKind(getPlatform());
      const configured = getConfiguredRpId()?.trim().toLowerCase();
      // Native apps run on localhost (Capacitor's https://localhost, capacitor://localhost),
      // which no website can confirm. The configured domain is the one the Digital Asset
      // Links (Android) and associated domains (iOS) files are checked against.
      if (kind !== "web" && configured) return configured;
      return resolveRpId(getHostname(), getConfiguredRpId());
    },
  };
}
