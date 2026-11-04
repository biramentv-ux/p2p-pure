// NOTE: the official draft-irtf-cfrg-cpace CPACE-RISTR255-SHA512 test vectors could not be
// fetched in the build environment (ietf.org egress denied), so they are NOT included
// here and none were invented. Only structural/property tests below.
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
    const rnd = () => new Uint8Array(64).fill(7);
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
