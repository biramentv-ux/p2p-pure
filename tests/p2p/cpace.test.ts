// Official CPACE-RISTR255-SHA512 vectors: draft-irtf-cfrg-cpace-21, file testvectors.json
// ("G_Coffee25519") in https://github.com/cfrg/draft-irtf-cfrg-cpace, plus property tests.
import { describe, it, expect } from "vitest";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { CpaceError, cpaceFinish, cpaceStart, generatorString, lvCat, calculateGenerator } from "../../src/p2p/cpace";

const enc = (s: string) => new TextEncoder().encode(s);
const input = (pw: string) => ({ prs: enc(pw), ci: enc("ci"), sid: enc("session-1") });

describe("cpace helpers", () => {
  it("lvCat length-prefixes each field (LEB128)", () => {
    expect([...lvCat(enc("ab"), new Uint8Array(0))]).toEqual([2, 97, 98, 0]);
    expect(lvCat(new Uint8Array(200))[0]).toBe(0xc8);
    expect(lvCat(new Uint8Array(200))[1]).toBe(0x01);
  });
  it("generator string is zero padded past the SHA-512 block start", () => {
    const gs = generatorString(enc("CPaceRistretto255"), enc("pw"), enc("ci"), enc("sid"));
    expect(gs.length).toBeGreaterThan(128 - 1);
  });
  it("generator depends on every input", () => {
    const a = calculateGenerator(enc("a"), enc("c"), enc("s")).toBytes();
    expect(calculateGenerator(enc("b"), enc("c"), enc("s")).toBytes()).not.toEqual(a);
    expect(calculateGenerator(enc("a"), enc("d"), enc("s")).toBytes()).not.toEqual(a);
    expect(calculateGenerator(enc("a"), enc("c"), enc("t")).toBytes()).not.toEqual(a);
  });
});

describe("cpace exchange", () => {
  it("same password gives same 64-byte ISK", () => {
    const a = cpaceStart(input("lemon-rocket-bridge"));
    const b = cpaceStart(input("lemon-rocket-bridge"));
    const ia = cpaceFinish(a.state, b.msg, "initiator");
    const ib = cpaceFinish(b.state, a.msg, "responder");
    expect(ia).toHaveLength(64);
    expect(ia).toEqual(ib);
  });
  it("different password gives different ISK", () => {
    const a = cpaceStart(input("lemon-rocket-bridge"));
    const b = cpaceStart(input("lemon-rocket-bridgx"));
    expect(cpaceFinish(a.state, b.msg, "initiator")).not.toEqual(cpaceFinish(b.state, a.msg, "responder"));
  });
  it("different sid gives different ISK", () => {
    const a = cpaceStart(input("pw"));
    const b = cpaceStart({ ...input("pw"), sid: enc("other") });
    expect(cpaceFinish(a.state, b.msg, "initiator")).not.toEqual(cpaceFinish(b.state, a.msg, "responder"));
  });
  it("wrong roles give different ISK (ordered transcript)", () => {
    const a = cpaceStart(input("pw"));
    const b = cpaceStart(input("pw"));
    expect(cpaceFinish(a.state, b.msg, "initiator")).not.toEqual(cpaceFinish(b.state, a.msg, "initiator"));
  });
  it("deterministic with injected randomness", () => {
    const rnd = () => new Uint8Array(32).fill(7);
    expect(cpaceStart(input("pw"), rnd).msg).toEqual(cpaceStart(input("pw"), rnd).msg);
  });
  it("rejects the identity point", () => {
    const a = cpaceStart(input("pw"));
    const id = ristretto255.Point.ZERO.toBytes();
    expect(() => cpaceFinish(a.state, lvCat(id, new Uint8Array(0)), "initiator")).toThrow(CpaceError);
  });
  it("rejects truncated, garbage and non-canonical messages", () => {
    const b = cpaceStart(input("pw"));
    for (const bad of [
      new Uint8Array(0),
      b.msg.subarray(0, 10),
      new Uint8Array(40).fill(0xff),
      lvCat(new Uint8Array(32).fill(0xff), new Uint8Array(0)),
      lvCat(new Uint8Array(31), new Uint8Array(0)),
      concatBytes(b.msg, new Uint8Array([1])),
    ]) {
      const a = cpaceStart(input("pw"));
      expect(() => cpaceFinish(a.state, bad, "initiator")).toThrow(CpaceError);
    }
  });
  it("state is single use", () => {
    const a = cpaceStart(input("pw"));
    const b = cpaceStart(input("pw"));
    cpaceFinish(a.state, b.msg, "initiator");
    expect(() => cpaceFinish(a.state, b.msg, "initiator")).toThrow(CpaceError);
  });
});

function concatBytes(a: Uint8Array, b: Uint8Array) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();

describe("official test vectors (draft-irtf-cfrg-cpace-21, ristretto255 / SHA-512)", () => {
  const tv = {
    PRS: "50617373776F7264",
    CI: "0B415F696E69746961746F720B425F726573706F6E646572",
    sid: "7E4B4791D6A8EF019B936C79FB7F2C57",
    g: "222B6B195FE84B1652BADB6F6A3AE3D24341E7306967F0B8115B40D5698C7E56",
    ya: "DA3D23700A9E5699258AEF94DC060DFDA5EBB61F02A5EA77FAD53F4FF0976D08",
    ADa: "414461",
    Ya: "D6BAC480F2C386C394EFC7C47ADB9925DCD2630B64F240C50F8D0EEC482B9157",
    yb: "D2316B454718C35362D83D69DF6320F38578ED5984651435E2949762D900B80D",
    ADb: "414462",
    Yb: "3EA7E0B19560D7C0B0F5734F63B955286DFA8232B5EBE63324E2D9E7433F7258",
    K: "80B69A8A76457AB6A4D7F887A4BF6B55A2F80AC19C333F917A05FC9887C8B40F",
    ISK_IR:
      "B69EFFBF61B51D56401C0F65601ABE428DE8206FEAAF0E32198896DCAE7B35CD2B38950A39DFD5D4A79164614C2984F7DAA460B588C1E80C3FA2068AF7900447",
  };
  const base = { prs: hex(tv.PRS), ci: hex(tv.CI), sid: hex(tv.sid) };

  it("calculate_generator matches g", () => {
    expect(toHex(calculateGenerator(base.prs, base.ci, base.sid).toBytes())).toBe(tv.g);
  });

  it("Ya, Yb and ISK_IR match on both sides", () => {
    const a = cpaceStart({ ...base, ad: hex(tv.ADa) }, () => hex(tv.ya));
    const b = cpaceStart({ ...base, ad: hex(tv.ADb) }, () => hex(tv.yb));
    expect(toHex(a.msg)).toBe(toHex(lvCat(hex(tv.Ya), hex(tv.ADa))));
    expect(toHex(b.msg)).toBe(toHex(lvCat(hex(tv.Yb), hex(tv.ADb))));
    expect(toHex(cpaceFinish(a.state, b.msg, "initiator"))).toBe(tv.ISK_IR);
    expect(toHex(cpaceFinish(b.state, a.msg, "responder"))).toBe(tv.ISK_IR);
  });

  it("K = ya * Yb", () => {
    const y = hex(tv.ya);
    let n = 0n;
    for (let i = y.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(y[i]);
    expect(toHex(ristretto255.Point.fromBytes(hex(tv.Yb)).multiply(n).toBytes())).toBe(tv.K);
  });
});
