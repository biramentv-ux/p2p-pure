import { describe, it, expect } from "vitest";
import {
  fetchInvitation,
  formatShortCode,
  INVITE_CODE_ALPHABET,
  normalizeShortCode,
  shareInvitation,
  ShortInviteError,
} from "../../src/p2p/shortInvite";

const INVITE = "p2p1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const BASE = "https://tg.test";

function reply(status: number, body?: unknown): (u: string, i?: RequestInit) => Promise<Response> {
  return async () => new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe("short code helpers", () => {
  it("uses the same alphabet as the Worker", () => {
    expect(INVITE_CODE_ALPHABET).toBe("23456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it("normalizes typed codes and rejects non-codes", () => {
    expect(normalizeShortCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeShortCode("ABCDE FGHJK")).toBe("ABCDEFGHJK");
    expect(normalizeShortCode("ABCDEFGHJ0")).toBeNull();
    expect(normalizeShortCode("ABC")).toBeNull();
  });

  it("formats codes in two groups", () => {
    expect(formatShortCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
  });
});

describe("shareInvitation", () => {
  it("posts the invitation and returns the code", async () => {
    let seen: { url: string; body: string } | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen = { url, body: String(init?.body) };
      return new Response(JSON.stringify({ code: "ABCDEFGHJK", expiresInSec: 600 }), { status: 201 });
    };
    const out = await shareInvitation(INVITE, fetchImpl, BASE);
    expect(out).toEqual({ code: "ABCDEFGHJK", expiresInSec: 600 });
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe(`${BASE}/invite`);
    expect(JSON.parse(seen!.body)).toEqual({ invitation: INVITE });
  });

  it("reports a network failure", async () => {
    const fetchImpl = async () => {
      throw new TypeError("offline");
    };
    await expect(shareInvitation(INVITE, fetchImpl, BASE)).rejects.toMatchObject({ code: "network" });
  });

  it("reports a busy server", async () => {
    await expect(shareInvitation(INVITE, reply(503), BASE)).rejects.toMatchObject({ code: "busy" });
  });
});

describe("fetchInvitation", () => {
  it("returns the invitation for a valid code", async () => {
    let url = "";
    const fetchImpl = async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ invitation: INVITE }), { status: 200 });
    };
    expect(await fetchInvitation("abcde-fghjk", fetchImpl, BASE)).toBe(INVITE);
    expect(url).toBe(`${BASE}/invite/ABCDEFGHJK`);
  });

  it("refuses a malformed code without calling the server", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response(null, { status: 200 });
    };
    await expect(fetchInvitation("short", fetchImpl, BASE)).rejects.toBeInstanceOf(ShortInviteError);
    expect(called).toBe(false);
  });

  it("explains an unknown or used code", async () => {
    await expect(fetchInvitation("ABCDEFGHJK", reply(404), BASE)).rejects.toMatchObject({ code: "not_found" });
  });
});
