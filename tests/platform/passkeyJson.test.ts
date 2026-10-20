import { describe, it, expect } from "vitest";
import { creationOptionsToJson, parseCredentialResponse, requestOptionsToJson } from "../../src/platform/mobile/passkeyJson";
import { bytesToB64u, b64uToBytes } from "../../src/platform/mobile/b64u";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("base64url helpers", () => {
  it("round-trips bytes without padding characters", () => {
    const b = bytes(0, 1, 2, 250, 251, 252, 253, 254, 255);
    const s = bytesToB64u(b);
    expect(s).not.toMatch(/[+/=]/);
    expect(b64uToBytes(s)).toEqual(b);
  });
});

describe("creation options", () => {
  it("encodes challenge, user id and PRF salt as base64url and keeps the rpId", () => {
    const json = JSON.parse(
      creationOptionsToJson({
        challenge: bytes(1, 2, 3),
        rp: { name: "P2P", id: "dyrakarmy.online" },
        user: { id: bytes(9), name: "alice", displayName: "alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: { eval: { first: bytes(7, 7) } } },
        timeout: 60000,
      }),
    );
    expect(json.challenge).toBe(bytesToB64u(bytes(1, 2, 3)));
    expect(json.user.id).toBe(bytesToB64u(bytes(9)));
    expect(json.rp.id).toBe("dyrakarmy.online");
    expect(json.extensions.prf.eval.first).toBe(bytesToB64u(bytes(7, 7)));
  });
});

describe("request options", () => {
  it("encodes allowCredentials ids", () => {
    const json = JSON.parse(
      requestOptionsToJson({
        challenge: bytes(1),
        rpId: "dyrakarmy.online",
        allowCredentials: [{ type: "public-key", id: bytes(4, 5) }],
        userVerification: "required",
      }),
    );
    expect(json.allowCredentials[0].id).toBe(bytesToB64u(bytes(4, 5)));
    expect(json.rpId).toBe("dyrakarmy.online");
  });
});

describe("parsing responses", () => {
  it("reads the credential id and the PRF output", () => {
    const prf = bytesToB64u(new Uint8Array(32).fill(5));
    const parsed = parseCredentialResponse(
      JSON.stringify({
        rawId: bytesToB64u(bytes(1, 2, 3)),
        clientExtensionResults: { prf: { results: { first: prf } } },
      }),
    );
    expect(Array.from(new Uint8Array(parsed.credentialId))).toEqual([1, 2, 3]);
    expect(parsed.prfSecret).toEqual(new Uint8Array(32).fill(5));
  });

  it("returns null PRF when the authenticator did not provide it", () => {
    const parsed = parseCredentialResponse(JSON.stringify({ id: bytesToB64u(bytes(8)) }));
    expect(parsed.prfSecret).toBeNull();
  });

  it("rejects a response without an id", () => {
    expect(() => parseCredentialResponse("{}")).toThrow();
  });
});
