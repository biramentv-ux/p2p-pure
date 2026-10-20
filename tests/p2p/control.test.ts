import { describe, expect, it } from "vitest";
import { CONTROL_MARK, decodeControl, encodeControl, isControlMessage } from "../../src/p2p/control";
import { sanitizeText } from "../../src/p2p/photo";

describe("control messages", () => {
  it("round-trips a location and a wipe", () => {
    const loc = { t: "loc" as const, fix: { lat: 42.6977, lng: 23.3219, accuracy: 12 } };
    expect(decodeControl(encodeControl(loc))).toEqual(loc);
    expect(decodeControl(encodeControl({ t: "wipe" }))).toEqual({ t: "wipe" });
  });

  it("refuses coordinates that are not on Earth", () => {
    const bad = (lat: number, lng: number, accuracy = 5) =>
      decodeControl(CONTROL_MARK + JSON.stringify({ t: "loc", lat, lng, accuracy }));
    expect(bad(91, 0)).toBeNull();
    expect(bad(0, 181)).toBeNull();
    expect(bad(Number.NaN, 0)).toBeNull();
    expect(bad(0, 0, -1)).toBeNull();
    expect(bad(0, 0, 1_000_000)).toBeNull();
    expect(decodeControl(CONTROL_MARK + JSON.stringify({ t: "loc", lat: "1", lng: 2, accuracy: 3 }))).toBeNull();
  });

  it("ignores malformed input and unknown types", () => {
    expect(decodeControl("Здрасти")).toBeNull();
    expect(decodeControl(CONTROL_MARK + "{nope")).toBeNull();
    expect(decodeControl(CONTROL_MARK + JSON.stringify({ t: "delete-everything" }))).toBeNull();
    expect(isControlMessage(encodeControl({ t: "wipe" }))).toBe(true);
  });

  it("typed text cannot send a control message", () => {
    expect(isControlMessage(sanitizeText(encodeControl({ t: "wipe" })))).toBe(false);
  });
});
