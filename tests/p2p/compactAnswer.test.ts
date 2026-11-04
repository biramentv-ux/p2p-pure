import { describe, it, expect } from "vitest";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { publicKeyToDidKey } from "../../src/identity/didKey";
import { createInvitation, INVITATION_TTL_MS, type Invitation } from "../../src/p2p/invitation";
import { createEphemeralKeyPair } from "../../src/p2p/secureSession";
import { summarizeCandidates } from "../../src/p2p/network";
import {
  COMPACT_ANSWER_TARGET_BYTES,
  COMPACT_ANSWER_VERSION,
  CompactAnswerError,
  MAX_COMPACT_ANSWER_BYTES,
  decodeCompactAnswer,
  encodeCompactAnswer,
  formatIpv6,
  parseDataChannelSdp,
  parseIpv6,
  validateDataChannelAnswerSdp,
} from "../../src/p2p/compactAnswer";

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const ephA = createEphemeralKeyPair().publicKey;
const ephB = createEphemeralKeyPair().publicKey;
const NOW = 1_790_000_000_000;

const FP =
  "D2:FA:0E:C3:22:59:5E:14:95:69:92:3D:13:B4:84:24:2C:C2:A2:C0:3E:FD:34:8E:5E:EA:6F:AF:52:CE:E6:0F";

/** Chrome answer SDP for a data-channel-only offer (shape as emitted by Chrome 120+). */
const CHROME_ANSWER = [
  "v=0",
  "o=- 6587364245213012934 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:2437072876 1 udp 2122260223 4f1c7a9e-2b3d-4c5e-8f60-1a2b3c4d5e6f.local 54321 typ host generation 0 network-id 1 network-cost 10",
  "a=candidate:1876313031 1 udp 2122262783 2a01:5a8:304:1234:abcd:ef01:2345:6789 54322 typ host generation 0 network-id 2 network-cost 10",
  "a=candidate:3972171812 1 udp 1686052607 85.130.11.45 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1 network-cost 10",
  "a=candidate:3620158860 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1 network-cost 10",
  "a=ice-ufrag:Xk3p",
  "a=ice-pwd:Qw8rTzLpMnBvCxZaSdFgHjKl",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FP}`,
  "a=setup:active",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n") + "\r\n";

/** Firefox answer SDP: session-level fingerprint, uppercase UDP, hex ICE credentials. */
const FIREFOX_ANSWER = [
  "v=0",
  "o=mozilla...THIS_IS_SDPARTA-128.0 4294967296123456789 0 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  `a=fingerprint:sha-256 ${FP}`,
  "a=group:BUNDLE 0",
  "a=ice-options:trickle",
  "a=msid-semantic:WMS *",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:0 1 UDP 2122252543 9b36eaac-bb2e-49bb-bb78-21c41c499900.local 61203 typ host",
  "a=candidate:1 1 UDP 2122187007 192.168.1.40 61204 typ host",
  "a=candidate:2 1 TCP 2105524479 192.168.1.40 9 typ host tcptype active",
  "a=candidate:3 1 UDP 1686052863 85.130.11.46 61203 typ srflx raddr 0.0.0.0 rport 0",
  "a=sendrecv",
  "a=end-of-candidates",
  "a=ice-pwd:7c1a7a3b0f2e4d5c6b7a8f9e0d1c2b3a",
  "a=ice-ufrag:5e1f2a3b",
  "a=mid:0",
  "a=setup:active",
  "a=sctp-port:5000",
  "a=max-message-size:1073741823",
].join("\r\n") + "\r\n";

/** Safari (libwebrtc) answer SDP: mDNS host, IPv6 host, srflx, a relay from a user TURN. */
const SAFARI_ANSWER = [
  "v=0",
  "o=- 2890844526 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:842163049 1 udp 2113937151 0c5e7d1a-3f2b-4a6c-9d8e-7f6a5b4c3d2e.local 60011 typ host generation 0 network-cost 999",
  "a=candidate:1510613869 1 udp 2113939711 2001:db8:85a3:0:0:8a2e:370:7334 60012 typ host generation 0 network-cost 999",
  "a=candidate:2999745851 1 udp 1677729535 94.155.20.7 60011 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999",
  "a=candidate:1052693134 1 udp 33562623 203.0.113.9 3478 typ relay raddr 94.155.20.7 rport 60011 generation 0 network-cost 999",
  "a=ice-ufrag:aB+/",
  "a=ice-pwd:zY9xW8vU7tS6rQ5pO4nM3lK2",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FP}`,
  "a=setup:active",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n") + "\r\n";

const OFFER_SDP = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host generation 0",
  "a=ice-ufrag:OfFr",
  "a=ice-pwd:OfferPasswordOfferPassw",
  "a=ice-options:trickle",
  `a=fingerprint:sha-256 ${FP.replace(/^D2/, "AA")}`,
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
].join("\r\n") + "\r\n";

function makeOffer(sdp = OFFER_SDP): Invitation {
  return createInvitation("offer", sdp, alice, ephA, { now: NOW });
}

function encode(answerSdp: string, offer: Invitation, extra: { now?: number; maxBytes?: number } = {}) {
  return encodeCompactAnswer({
    answerSdp,
    identity: bob,
    ephemeralPublicKey: ephB,
    offerNonce: offer.nonce,
    now: extra.now ?? NOW,
    maxBytes: extra.maxBytes,
  });
}

function expectCode(fn: () => unknown, codes: CompactAnswerError["code"][]) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CompactAnswerError);
    expect(codes).toContain((e as CompactAnswerError).code);
    return (e as CompactAnswerError).code;
  }
  throw new Error("expected CompactAnswerError");
}

const FIXTURES = { Chrome: CHROME_ANSWER, Firefox: FIREFOX_ANSWER, Safari: SAFARI_ANSWER };

describe("compact answer: round trip on browser SDPs", () => {
  for (const [browser, sdp] of Object.entries(FIXTURES)) {
    it(`${browser}: fits, verifies and rebuilds a valid answer SDP`, () => {
      const offer = makeOffer();
      const bytes = encode(sdp, offer);
      const small = encode(sdp, offer, { maxBytes: COMPACT_ANSWER_TARGET_BYTES });
      console.log(
        `[compactAnswer] ${browser}: ${bytes.length} B (default budget), ${small.length} B (200 B budget)`,
      );
      expect(bytes[0]).toBe(COMPACT_ANSWER_VERSION);
      expect(bytes.length).toBeLessThanOrEqual(MAX_COMPACT_ANSWER_BYTES);
      expect(small.length).toBeLessThanOrEqual(COMPACT_ANSWER_TARGET_BYTES);

      for (const b of [bytes, small]) {
        const ans = decodeCompactAnswer(b, offer, NOW + 1000);
        expect(ans.kind).toBe("answer");
        expect(ans.publicKey).toEqual(bob.publicKey);
        expect(ans.ephemeralPublicKey).toEqual(ephB);
        expect(ans.answersNonce).toEqual(offer.nonce);
        expect(ans.did).toBe(publicKeyToDidKey(bob.publicKey));
        expect(ans.nonce.length).toBe(16);
        expect(ans.expiresAt).toBe(Math.floor(NOW / 1000) * 1000 + INVITATION_TTL_MS);

        const orig = parseDataChannelSdp(sdp);
        const rebuilt = validateDataChannelAnswerSdp(ans.sdp);
        expect(rebuilt.fingerprint).toEqual(orig.fingerprint);
        expect(rebuilt.ufrag).toBe(orig.ufrag);
        expect(rebuilt.pwd).toBe(orig.pwd);
        expect(rebuilt.setup).toBe(orig.setup);
        expect(rebuilt.mid).toBe("0");
        expect(rebuilt.sctpPort).toBe(orig.sctpPort);
        expect(rebuilt.maxMessageSize).toBe(orig.maxMessageSize);
        expect(ans.sdp).toContain(`a=fingerprint:sha-256 ${FP}`);
        expect(ans.sdp).toContain("a=end-of-candidates");
        expect(ans.sdp).not.toContain(".local");
        expect(ans.sdp).not.toMatch(/typ relay|\btcp\b/);
        expect(ans.sdp.endsWith("\r\n")).toBe(true);

        // Every rebuilt candidate is one of the original usable candidates.
        expect(rebuilt.candidates.length).toBeGreaterThanOrEqual(1);
        for (const c of rebuilt.candidates) {
          expect(
            orig.candidates.some(
              (o) => o.type === c.type && o.port === c.port && o.address.join() === c.address.join(),
            ),
          ).toBe(true);
        }
        // srflx IPv4 is ranked first, so it is always kept.
        expect(rebuilt.candidates[0].type).toBe("srflx");
        // network.ts still reads the rebuilt SDP as reachable over the internet.
        expect(summarizeCandidates(ans.sdp).publicIpv4).toBe(true);
      }
    });
  }

  it("keeps the public IPv6 host from Chrome within the 220-byte budget", () => {
    const offer = makeOffer();
    const ans = decodeCompactAnswer(encode(CHROME_ANSWER, offer), offer, NOW);
    expect(ans.sdp).toContain("2a01:5a8:304:1234:abcd:ef01:2345:6789 54322 typ host");
    expect(summarizeCandidates(ans.sdp).publicIpv6).toBe(true);
  });

  it("uses the mid from the offer", () => {
    const offerSdp = OFFER_SDP.replace(/a=mid:0/, "a=mid:dc").replace("BUNDLE 0", "BUNDLE dc");
    const answerSdp = CHROME_ANSWER.replace(/a=mid:0/, "a=mid:dc").replace("BUNDLE 0", "BUNDLE dc");
    const offer = makeOffer(offerSdp);
    const ans = decodeCompactAnswer(encode(answerSdp, offer), offer, NOW);
    expect(ans.sdp).toContain("a=mid:dc");
    expect(ans.sdp).toContain("a=group:BUNDLE dc");
  });

  it("carries a non-default sctp-port, a custom max-message-size and passive setup", () => {
    const sdp = CHROME_ANSWER.replace("a=sctp-port:5000", "a=sctp-port:5001")
      .replace("a=max-message-size:262144", "a=max-message-size:65536")
      .replace("a=setup:active", "a=setup:passive");
    const offer = makeOffer();
    const p = validateDataChannelAnswerSdp(decodeCompactAnswer(encode(sdp, offer), offer, NOW).sdp);
    expect(p.sctpPort).toBe(5001);
    expect(p.maxMessageSize).toBe(65536);
    expect(p.setup).toBe("passive");
  });

  it("omits max-message-size when the answer had none", () => {
    const sdp = CHROME_ANSWER.replace("a=max-message-size:262144\r\n", "");
    const offer = makeOffer();
    const ans = decodeCompactAnswer(encode(sdp, offer), offer, NOW);
    expect(ans.sdp).not.toContain("max-message-size");
  });
});

describe("compact answer: rejection", () => {
  const offer = makeOffer();
  const good = encode(CHROME_ANSWER, offer);

  it("rejects every single-byte change", () => {
    const seen = new Set<string>();
    for (let i = 0; i < good.length; i++) {
      const t = good.slice();
      t[i] ^= 0x01;
      // Bytes 66..69 are the offer binding: a change there looks exactly like another offer.
      const allowed: CompactAnswerError["code"][] =
        i >= 66 && i < 70 ? ["wrong_offer"] : ["bad_signature", "malformed"];
      seen.add(expectCode(() => decodeCompactAnswer(t, offer, NOW), allowed));
    }
    expect(seen.has("bad_signature")).toBe(true);
  });

  it("rejects truncation and trailing bytes", () => {
    expectCode(() => decodeCompactAnswer(good.slice(0, good.length - 1), offer, NOW), [
      "bad_signature",
      "malformed",
    ]);
    expectCode(() => decodeCompactAnswer(good.slice(0, 50), offer, NOW), ["malformed"]);
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expectCode(() => decodeCompactAnswer(longer, offer, NOW), ["malformed", "bad_signature", "too_large"]);
  });

  it("rejects oversized input before parsing", () => {
    expectCode(() => decodeCompactAnswer(new Uint8Array(MAX_COMPACT_ANSWER_BYTES + 1), offer, NOW), [
      "too_large",
    ]);
  });

  it("rejects unknown version and reserved flags", () => {
    const v = good.slice();
    v[0] = 2;
    expectCode(() => decodeCompactAnswer(v, offer, NOW), ["malformed"]);
    const f = good.slice();
    f[1] |= 0x80;
    expectCode(() => decodeCompactAnswer(f, offer, NOW), ["malformed"]);
  });

  it("rejects an answer made for another offer", () => {
    const other = makeOffer();
    expectCode(() => decodeCompactAnswer(good, other, NOW), ["wrong_offer"]);
  });

  it("rejects an answer signed by someone other than the embedded identity", () => {
    const t = good.slice();
    t.set(alice.publicKey, 2); // swap identity, keep bob's signature
    expectCode(() => decodeCompactAnswer(t, offer, NOW), ["bad_signature"]);
  });

  it("rejects an expired answer and one from far in the future", () => {
    expectCode(() => decodeCompactAnswer(good, offer, NOW + INVITATION_TTL_MS + 1000), ["expired"]);
    expectCode(() => decodeCompactAnswer(good, offer, NOW - INVITATION_TTL_MS - 1000), ["expired"]);
    expect(() => decodeCompactAnswer(good, offer, NOW + INVITATION_TTL_MS - 1000)).not.toThrow();
  });

  it("refuses a non-offer as the reference", () => {
    const answerInv = createInvitation("answer", OFFER_SDP, bob, ephB, { answersNonce: offer.nonce });
    expectCode(() => decodeCompactAnswer(good, answerInv, NOW), ["wrong_offer"]);
  });
});

describe("compact answer: encoder input checks", () => {
  const offer = makeOffer();

  it("trims to at most 3 candidates and stays within the budget", () => {
    const extra = Array.from(
      { length: 8 },
      (_, i) => `a=candidate:9${i} 1 udp ${1686052607 - i} 85.130.12.${i + 1} ${40000 + i} typ srflx raddr 0.0.0.0 rport 0`,
    ).join("\r\n");
    const sdp = CHROME_ANSWER.replace("a=ice-ufrag", `${extra}\r\na=ice-ufrag`);
    const bytes = encode(sdp, offer);
    expect(bytes.length).toBeLessThanOrEqual(MAX_COMPACT_ANSWER_BYTES);
    const p = parseDataChannelSdp(decodeCompactAnswer(bytes, offer, NOW).sdp);
    expect(p.candidates.length).toBe(3);
  });

  it("drops duplicate candidates", () => {
    const dup =
      "a=candidate:77 1 udp 1686052600 85.130.11.45 54321 typ srflx raddr 192.168.1.23 rport 54321\r\n";
    const sdp = CHROME_ANSWER.replace("a=ice-ufrag", `${dup}a=ice-ufrag`);
    const p = parseDataChannelSdp(decodeCompactAnswer(encode(sdp, offer), offer, NOW).sdp);
    const keys = p.candidates.map((c) => `${c.address.join()}:${c.port}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("throws too_large when no usable candidate fits", () => {
    expectCode(() => encode(CHROME_ANSWER, offer, { maxBytes: 180 }), ["too_large"]);
  });

  it("throws too_large for over-long ICE credentials", () => {
    const sdp = CHROME_ANSWER.replace(/a=ice-ufrag:\w+/, "a=ice-ufrag:" + "a".repeat(33));
    expectCode(() => encode(sdp, offer), ["too_large"]);
  });

  it("encodes an answer with only mDNS/TCP/relay candidates without candidates", () => {
    const sdp = CHROME_ANSWER.split("\r\n")
      .filter((l) => !l.startsWith("a=candidate:") || l.includes(".local") || l.includes(" tcp "))
      .join("\r\n");
    const ans = decodeCompactAnswer(encode(sdp, offer), offer, NOW);
    expect(parseDataChannelSdp(ans.sdp).candidates.length).toBe(0);
  });

  it("rejects SDP with audio/video or a wrong transport", () => {
    const av = CHROME_ANSWER + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
    expectCode(() => encode(av, offer), ["unsupported_sdp"]);
    const sctp = CHROME_ANSWER.replace("UDP/DTLS/SCTP webrtc-datachannel", "DTLS/SCTP 5000");
    expectCode(() => encode(sctp, offer), ["unsupported_sdp"]);
  });

  it("rejects missing fingerprint, actpass, and the old SHA-1 only fingerprint", () => {
    const noFp = CHROME_ANSWER.replace(/a=fingerprint:[^\r]+\r\n/, "");
    expectCode(() => encode(noFp, offer), ["unsupported_sdp"]);
    const actpass = CHROME_ANSWER.replace("a=setup:active", "a=setup:actpass");
    expectCode(() => encode(actpass, offer), ["unsupported_sdp"]);
    const sha1 = CHROME_ANSWER.replace(/sha-256 [0-9A-F:]+/, "sha-1 AB:CD");
    expectCode(() => encode(sha1, offer), ["unsupported_sdp"]);
  });

  it("validateDataChannelAnswerSdp rejects relay candidates", () => {
    expectCode(() => validateDataChannelAnswerSdp(SAFARI_ANSWER), ["unsupported_sdp"]);
  });
});

describe("compact answer: helpers", () => {
  it("round-trips IPv6 text through RFC 5952 form", () => {
    for (const [input, canonical] of [
      ["2001:db8:85a3:0:0:8a2e:370:7334", "2001:db8:85a3::8a2e:370:7334"],
      ["2A01:5A8:304:1234:ABCD:EF01:2345:6789", "2a01:5a8:304:1234:abcd:ef01:2345:6789"],
      ["fe80::1", "fe80::1"],
      ["::ffff:192.0.2.1", "::ffff:c000:201"],
    ]) {
      const b = parseIpv6(input);
      expect(b).not.toBeNull();
      expect(formatIpv6(b as Uint8Array)).toBe(canonical);
    }
    expect(parseIpv6("1:2:3")).toBeNull();
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("abcd.local")).toBeNull();
  });
});
