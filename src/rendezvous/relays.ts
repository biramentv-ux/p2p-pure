/**
 * Relays the app may use (Н2). The CSP's connect-src lists exactly these (vite.config.ts,
 * checked by tests/rendezvous/csp.test.ts). Kept apart from relayPool.ts so the settings
 * screen does not pull the relay code into the main bundle.
 */
export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://relay.snort.social"];
