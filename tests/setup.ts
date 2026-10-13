import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

// jsdom's environment doesn't implement SubtleCrypto; use Node's WebCrypto,
// which is API-compatible, whenever jsdom's own crypto lacks `.subtle`.
if (!globalThis.crypto || !("subtle" in globalThis.crypto)) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
