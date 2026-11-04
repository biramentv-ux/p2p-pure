import { describe, it, expect } from "vitest";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  ROOM_ID_ALPHABET,
  formatPairingCode,
  newPairingWords,
  normalizeRoomId,
  parsePairingCode,
  pairingPassword,
} from "../../src/p2p/pairingCode";

const code = { room: "K7M2Q", words: ["lemon", "rocket", "bridge"] as [string, string, string] };

describe("pairing words", () => {
  it("maps 5 bytes to three 11-bit indices", () => {
    // 33 bits: index0=0, index1=1, index2=2047 -> 00000000000 00000000001 11111111111 + 7 spare bits
    const bits = (0n << 29n) | (1n << 18n) | (2047n << 7n);
    const bytes = new Uint8Array(5);
    for (let i = 0; i < 5; i++) bytes[i] = Number((bits >> BigInt(32 - 8 * i)) & 0xffn);
    expect(newPairingWords(() => bytes)).toEqual([wordlist[0], wordlist[1], wordlist[2047]]);
  });

  it("is spread across the list", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const w of newPairingWords()) seen.add(w);
    expect(seen.size).toBeGreaterThan(500);
    for (const w of seen) expect(wordlist).toContain(w);
  });
});

describe("room id", () => {
  it("normalizes case and separators", () => {
    expect(normalizeRoomId("k7m-2q")).toBe("K7M2Q");
    expect(normalizeRoomId(" k7m 2q ")).toBe("K7M2Q");
  });
  it("rejects bad length and characters", () => {
    expect(normalizeRoomId("K7M2")).toBeNull();
    expect(normalizeRoomId("K7M2QQ")).toBeNull();
    expect(normalizeRoomId("K7M20")).toBeNull(); // 0 not in alphabet
    expect(ROOM_ID_ALPHABET).toHaveLength(30);
  });
});

describe("format / parse", () => {
  it("formats", () => expect(formatPairingCode(code)).toBe("K7M2Q · lemon-rocket-bridge"));
  it("round-trips", () => expect(parsePairingCode(formatPairingCode(code))).toEqual(code));
  it("accepts any case and separators", () => {
    for (const s of ["k7m2q lemon rocket bridge", "K7M2Q-LEMON-ROCKET-BRIDGE", "k7m2q,lemon_rocket.bridge", "K7M2Q · Lemon · Rocket · Bridge"])
      expect(parsePairingCode(s)).toEqual(code);
  });
  it("accepts unique 4-letter prefixes and short full words", () => {
    expect(parsePairingCode("K7M2Q lemo rock brid")).toEqual(code);
    expect(parsePairingCode("K7M2Q add lemon rocket")?.words[0]).toBe("add");
  });
  it("rejects unknown words, ambiguous or too-short prefixes, wrong counts, bad room", () => {
    expect(parsePairingCode("K7M2Q lemon rocket zzzz")).toBeNull();
    expect(parsePairingCode("K7M2Q lemon rocket bri")).toBeNull();
    expect(parsePairingCode("K7M2Q lemon rocket")).toBeNull();
    expect(parsePairingCode("K7M2Q lemon rocket bridge extra")).toBeNull();
    expect(parsePairingCode("K7M0Q lemon rocket bridge")).toBeNull();
    expect(parsePairingCode("")).toBeNull();
  });
});

describe("password", () => {
  it("is the canonical words only, without the room", () => {
    const pw = new TextDecoder().decode(pairingPassword(code));
    expect(pw).toBe("lemon-rocket-bridge");
    expect(pw).not.toContain("K7M2Q");
  });
});
