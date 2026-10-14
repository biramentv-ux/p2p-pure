/**
 * WebAuthn passkey module.
 *
 * IMPORTANT — role of the passkey in this app:
 * The passkey is NOT used to derive the Signal/did:key identity. WebAuthn
 * exposes no raw ECDH or arbitrary-message-signing API, and its private
 * key is non-extractable hardware-bound material — incompatible with the
 * BIP39-mnemonic recovery requirement (a new device has a different
 * secure enclave and could never reproduce the same key).
 *
 * Instead, the passkey is a device-local unlock gate:
 *   - On supporting authenticators (PRF extension / "hmac-secret"), we
 *     evaluate PRF with a fixed app-specific salt to get a stable,
 *     hardware-backed symmetric secret. We run that secret through HKDF
 *     to get an AES-GCM key that encrypts the BIP39 seed at rest.
 *   - If PRF isn't supported, identityService falls back to a
 *     user-chosen password-based KDF (see identityService.ts).
 *
 * Every call here is a thin wrapper so the rest of the app never touches
 * `navigator.credentials` directly.
 */
import { IdentityError } from "./types";
import { asBufferSource } from "./bufferUtils";
import { getMobileBridge, nativePasskeys } from "../platform/mobile";
import { creationOptionsToJson, parseCredentialResponse, requestOptionsToJson } from "../platform/mobile/passkeyJson";

const RP_NAME = "P2P Messenger";
const PRF_SALT = new TextEncoder().encode("p2p-messenger/webauthn-prf/v1");

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined"
  );
}

function requireWebAuthn(): void {
  if (!isWebAuthnSupported()) {
    throw new IdentityError("WebAuthn is not supported in this browser.", "WEBAUTHN_UNSUPPORTED");
  }
}

function randomChallenge(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export interface CreatePasskeyResult {
  credentialId: ArrayBuffer;
  /** 32-byte PRF output, if the authenticator supports and returned it. */
  prfSecret: Uint8Array | null;
}

/**
 * Registers a new passkey (navigator.credentials.create), requesting the
 * PRF extension. rpId defaults to the current hostname.
 */
export async function createPasskey(
  userIdentifierLabel: string,
  rpId: string = getMobileBridge().passkeyRpId(),
): Promise<CreatePasskeyResult> {
  const native = nativePasskeys();
  if (native) {
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const { responseJson } = await native.create({
      requestJson: creationOptionsToJson({
        challenge: randomChallenge(),
        rp: { name: RP_NAME, id: rpId },
        user: { id: userId, name: userIdentifierLabel, displayName: userIdentifierLabel },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -8 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: PRF_SALT } } },
        timeout: 60_000,
      }),
    });
    const parsed = parseCredentialResponse(responseJson);
    return { credentialId: parsed.credentialId, prfSecret: parsed.prfSecret };
  }

  requireWebAuthn();

  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: asBufferSource(randomChallenge()),
      rp: { name: RP_NAME, id: rpId },
      user: {
        id: asBufferSource(userId),
        name: userIdentifierLabel,
        displayName: userIdentifierLabel,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -8 }, // Ed25519 (where supported)
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new IdentityError("Passkey creation was cancelled or failed.", "WEBAUTHN_UNSUPPORTED");
  }

  const extResults = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prfFirst = extResults.prf?.results?.first;

  return {
    credentialId: credential.rawId,
    prfSecret: prfFirst ? new Uint8Array(prfFirst) : null,
  };
}

export interface GetPasskeyResult {
  credentialId: ArrayBuffer;
  prfSecret: Uint8Array | null;
}

/**
 * Authenticates with an existing passkey (navigator.credentials.get),
 * re-evaluating PRF with the same salt to recover the same secret.
 */
export async function getPasskey(
  credentialId?: ArrayBuffer,
  rpId: string = getMobileBridge().passkeyRpId(),
): Promise<GetPasskeyResult> {
  const native = nativePasskeys();
  if (native) {
    const { responseJson } = await native.get({
      requestJson: requestOptionsToJson({
        challenge: randomChallenge(),
        rpId,
        allowCredentials: credentialId
          ? [{ type: "public-key", id: new Uint8Array(credentialId) }]
          : undefined,
        userVerification: "required",
        extensions: { prf: { eval: { first: PRF_SALT } } },
        timeout: 60_000,
      }),
    });
    const parsed = parseCredentialResponse(responseJson);
    return { credentialId: parsed.credentialId, prfSecret: parsed.prfSecret };
  }

  requireWebAuthn();

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: asBufferSource(randomChallenge()),
      rpId,
      allowCredentials: credentialId
        ? [{ type: "public-key", id: asBufferSource(new Uint8Array(credentialId)) }]
        : undefined,
      userVerification: "required",
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) {
    throw new IdentityError("Passkey authentication was cancelled or failed.", "WEBAUTHN_UNSUPPORTED");
  }

  const extResults = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prfFirst = extResults.prf?.results?.first;

  return {
    credentialId: assertion.rawId,
    prfSecret: prfFirst ? new Uint8Array(prfFirst) : null,
  };
}

export function credentialIdToBase64Url(id: ArrayBuffer): string {
  const bytes = new Uint8Array(id);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToCredentialId(b64url: string): ArrayBuffer {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    b64url.length + ((4 - (b64url.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
