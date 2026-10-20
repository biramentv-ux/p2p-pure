import { describe, expect, it } from "vitest";
import { CALL_MARK, decodeSignal, encodeSignal, isCallSignal, MAX_SDP_CHARS, PART_CHARS, SignalAssembler } from "../../src/call/signal";
import { sanitizeText } from "../../src/p2p/photo";

const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

describe("call signal encoding", () => {
  it("round-trips every signal type", () => {
    const signals = [
      { t: "invite", kind: "audio" },
      { t: "invite", kind: "video" },
      { t: "accept" },
      { t: "decline" },
      { t: "end" },
      { t: "sdp", type: "offer", sdp: SDP },
      { t: "sdp", type: "answer", sdp: SDP },
    ] as const;
    for (const s of signals) {
      const assembler = new SignalAssembler();
      const frames = encodeSignal(s);
      let out = null;
      for (const f of frames) out = assembler.feed(f) ?? out;
      expect(out).toEqual(s);
    }
  });

  it("does not mistake a chat message for a signal", () => {
    expect(isCallSignal("Здрасти")).toBe(false);
    expect(decodeSignal("Здрасти")).toBeNull();
    expect(decodeSignal('{"t":"invite","kind":"video"}')).toBeNull();
  });

  it("refuses malformed JSON and unknown types", () => {
    expect(decodeSignal(CALL_MARK + "{not json")).toBeNull();
    expect(decodeSignal(CALL_MARK + "null")).toBeNull();
    expect(decodeSignal(CALL_MARK + JSON.stringify({ t: "explode" }))).toBeNull();
  });

  it("refuses an invite with an unknown kind", () => {
    expect(decodeSignal(CALL_MARK + JSON.stringify({ t: "invite", kind: "screen" }))).toBeNull();
  });

  it("refuses SDP that is not SDP, or is too large", () => {
    expect(decodeSignal(CALL_MARK + JSON.stringify({ t: "sdp", type: "offer", sdp: "hello" }))).toBeNull();
    expect(decodeSignal(CALL_MARK + JSON.stringify({ t: "sdp", type: "rollback", sdp: SDP }))).toBeNull();
    const huge = "v=0" + "a".repeat(MAX_SDP_CHARS);
    expect(decodeSignal(CALL_MARK + JSON.stringify({ t: "sdp", type: "offer", sdp: huge }))).toBeNull();
  });

  it("every frame fits the session's message limit, and a long SDP is split and rebuilt", () => {
    const longSdp = "v=0\r\n" + "a=candidate:1 1 udp 2122260223 192.168.1.10 54321 typ host\r\n".repeat(120);
    const signal = { t: "sdp", type: "offer", sdp: longSdp } as const;
    const frames = encodeSignal(signal);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.length).toBeLessThanOrEqual(4000);
    const assembler = new SignalAssembler();
    let out = null;
    for (const f of frames) out = assembler.feed(f) ?? out;
    expect(out).toEqual(signal);
  });

  it("assembler drops a broken sequence and recovers on the next complete one", () => {
    const longSdp = "v=0\r\n" + "x".repeat(PART_CHARS * 3);
    const frames = encodeSignal({ t: "sdp", type: "offer", sdp: longSdp });
    const assembler = new SignalAssembler();
    expect(assembler.feed(frames[0])).toBeNull();
    expect(assembler.feed(frames[2])).toBeNull(); // part 1 missing
    let out = null;
    for (const f of encodeSignal({ t: "accept" })) out = assembler.feed(f) ?? out;
    expect(out).toEqual({ t: "accept" });
  });

  it("typed text cannot impersonate a call signal (the chat sanitizes the mark)", () => {
    const typed = sanitizeText(CALL_MARK + JSON.stringify({ t: "end" }));
    expect(isCallSignal(typed)).toBe(false);
  });
});
