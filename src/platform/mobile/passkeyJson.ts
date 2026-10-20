/**
 * WebAuthn options and responses in JSON form, for the Android Credential Manager.
 *
 * Credential Manager takes the same options as navigator.credentials, but as JSON
 * with binary fields encoded as base64url strings, and returns JSON. These helpers
 * convert both ways, so the web code and the native code share one data shape.
 */
import { bytesToB64u, b64uToBytes } from "./b64u";

export interface CreationOptionsLike {
  challenge: Uint8Array;
  rp: { name: string; id: string };
  user: { id: Uint8Array; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  authenticatorSelection?: { residentKey?: string; userVerification?: string };
  extensions?: { prf?: { eval: { first: Uint8Array } } };
  timeout?: number;
}

export interface RequestOptionsLike {
  challenge: Uint8Array;
  rpId: string;
  allowCredentials?: { type: "public-key"; id: Uint8Array }[];
  userVerification?: string;
  extensions?: { prf?: { eval: { first: Uint8Array } } };
  timeout?: number;
}

export function creationOptionsToJson(o: CreationOptionsLike): string {
  return JSON.stringify({
    challenge: bytesToB64u(o.challenge),
    rp: o.rp,
    user: { id: bytesToB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    authenticatorSelection: o.authenticatorSelection,
    timeout: o.timeout,
    extensions: o.extensions?.prf ? { prf: { eval: { first: bytesToB64u(o.extensions.prf.eval.first) } } } : undefined,
  });
}

export function requestOptionsToJson(o: RequestOptionsLike): string {
  return JSON.stringify({
    challenge: bytesToB64u(o.challenge),
    rpId: o.rpId,
    allowCredentials: o.allowCredentials?.map((c) => ({ type: c.type, id: bytesToB64u(c.id) })),
    userVerification: o.userVerification,
    timeout: o.timeout,
    extensions: o.extensions?.prf ? { prf: { eval: { first: bytesToB64u(o.extensions.prf.eval.first) } } } : undefined,
  });
}

export interface ParsedCredential {
  /** Raw credential id, as an ArrayBuffer like PublicKeyCredential.rawId. */
  credentialId: ArrayBuffer;
  /** 32-byte PRF output if the authenticator returned it. */
  prfSecret: Uint8Array | null;
}

/** Parses a registration or assertion response returned by Credential Manager. */
export function parseCredentialResponse(json: string): ParsedCredential {
  const r = JSON.parse(json) as {
    rawId?: string;
    id?: string;
    clientExtensionResults?: { prf?: { results?: { first?: string } } };
  };
  const id = r.rawId ?? r.id;
  if (!id) throw new Error("Credential response has no id.");
  const credentialId = b64uToBytes(id).buffer as ArrayBuffer;
  const first = r.clientExtensionResults?.prf?.results?.first;
  return { credentialId, prfSecret: first ? b64uToBytes(first) : null };
}
