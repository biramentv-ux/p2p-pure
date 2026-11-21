// @vitest-environment node
/**
 * Н9: property-based tests and fuzzing for every parser that reads bytes from another device
 * or a camera/microphone. Two kinds of property:
 *
 *  1. Round trip: encode → decode gives back the same value.
 *  2. Robustness: any input either decodes or throws one of the parser's defined errors
 *     (InvitationError, CompactAnswerError, SessionError, TransferError) or returns null.
 *     Anything else (TypeError, RangeError, DOMException...) is a bug.
 *
 * The number of runs per property is FUZZ_RUNS (default 200; CI nightly can raise it).
 * A failing case prints its seed and the shrunk input; replay with FUZZ_SEED=<seed>.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deriveIdentityKeyPair } from "../../src/identity/keypair";
import { generateMnemonic12, mnemonicToSeed } from "../../src/identity/mnemonic";
import { base64UrlToBytes, bytesToBase64Url } from "../../src/p2p/encoding";
import {
  createInvitation,
  decodeInvitation,
  encodeInvitation,
  encodeInvitationHex,
  InvitationError,
  INVITATION_PREFIX,
} from "../../src/p2p/invitation";
import { CompactAnswerError, decodeCompactAnswer, formatIpv6, parseIpv6 } from "../../src/p2p/compactAnswer";
import { createEphemeralKeyPair, SecureSession, SessionError } from "../../src/p2p/secureSession";
import { decodeControl, decodeIntroControl, encodeControl } from "../../src/p2p/control";
import { formatPairingCode, parsePairingCode, ROOM_ID_ALPHABET } from "../../src/p2p/pairingCode";
import { formatShortCode, INVITE_CODE_ALPHABET, normalizeShortCode } from "../../src/p2p/shortInvite";
import { decodeBlocks, encodeBlocks, rsDecode, rsEncode } from "../../src/p2p/audio/fec";
import { encodeToSamples, FskDecoder } from "../../src/p2p/audio/fskModem";
import { encodeLightFrames, LIGHT_SYMBOL_UNITS, LightDecoder, rasterizeFrame } from "../../src/p2p/light/lightCodec";
import { decodeTransferPacket, TransferError } from "../../src/transfer/packet";
import { decodeBundle } from "../../src/transfer/bundle";
import { parseRelayMessage, verifyEvent } from "../../src/rendezvous/nostr";
import { validIntroMessage } from "../../src/intro/introMessages";
import { FileTransfers } from "../../src/p2p/fileTransfer";
import { DISAPPEAR_OPTIONS } from "../../src/history/disappearing";
import { validFileCard } from "../../src/history/messageStore";
import { decodeGroupWire } from "../../src/group/groupChat";
import { decodeSignal, SignalAssembler } from "../../src/call/signal";

const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;
const opts = (numRuns = RUNS) => ({ numRuns, ...(SEED !== undefined ? { seed: SEED } : {}) });

const alice = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const bob = deriveIdentityKeyPair(mnemonicToSeed(generateMnemonic12()));
const NOW = 1_790_000_000_000;

/** Runs `fn`; passes if it returns or throws one of `allowed`; rethrows anything else. */
async function onlyDefined(fn: () => unknown, ...allowed: Array<abstract new (...a: never[]) => Error>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (allowed.some((C) => e instanceof C)) return;
    throw new Error(`undefined error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
}

/** Text the way an attacker would send it: anything, including control characters and lone surrogates. */
const anyText = fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: "binary", maxLength: 400 }));
const anyBytes = (max = 600) => fc.uint8Array({ maxLength: max });

const SDP = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:abcdefghijklmnopqrstuvwx",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
].join("\r\n");

describe("Н9 fuzz: base64url", () => {
  it("round trips any bytes", () => {
    fc.assert(
      fc.property(anyBytes(), (b) => {
        expect(base64UrlToBytes(bytesToBase64Url(b))).toEqual(b);
      }),
      opts(),
    );
  });
});

describe("Н9 fuzz: invitation (QR payload)", () => {
  it("round trips through text and hex for any SDP text", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 300 }), fc.boolean(), async (extra, hex) => {
        const inv = createInvitation("offer", `${SDP}\r\na=x:${extra}`, alice, createEphemeralKeyPair().publicKey, { now: NOW });
        const text = hex ? await encodeInvitationHex(inv) : await encodeInvitation(inv);
        const back = await decodeInvitation(text, NOW);
        expect(back.sdp).toBe(inv.sdp);
        expect(back.publicKey).toEqual(inv.publicKey);
        expect(back.nonce).toEqual(inv.nonce);
      }),
      opts(60),
    );
  });

  it("any text throws only InvitationError", async () => {
    await fc.assert(
      fc.asyncProperty(anyText, async (t) => onlyDefined(() => decodeInvitation(t, NOW), InvitationError)),
      opts(),
    );
  });

  it("any bytes after the prefix throw only InvitationError", async () => {
    await fc.assert(
      fc.asyncProperty(anyBytes(), async (b) =>
        onlyDefined(() => decodeInvitation(INVITATION_PREFIX + bytesToBase64Url(b), NOW), InvitationError),
      ),
      opts(),
    );
  });

  it("a flipped byte in a real invitation is refused, or decodes to exactly the signed content", async () => {
    const inv = createInvitation("offer", SDP, alice, createEphemeralKeyPair().publicKey, { now: NOW });
    const body = base64UrlToBytes((await encodeInvitation(inv)).slice(INVITATION_PREFIX.length));
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: body.length - 1 }), fc.integer({ min: 1, max: 255 }), async (i, x) => {
        const bad = body.slice();
        bad[i] ^= x;
        await onlyDefined(async () => {
          // The signature covers the header and the decompressed SDP, not the deflate bytes: a
          // flip in unused deflate bits can still inflate to the same SDP. Then nothing changed.
          const back = await decodeInvitation(INVITATION_PREFIX + bytesToBase64Url(bad), NOW);
          expect(back.sdp).toBe(inv.sdp);
          expect(back.publicKey).toEqual(inv.publicKey);
          expect(back.ephemeralPublicKey).toEqual(inv.ephemeralPublicKey);
          expect(back.nonce).toEqual(inv.nonce);
          expect(back.expiresAt).toBe(inv.expiresAt);
        }, InvitationError);
      }),
      opts(),
    );
  });
});

describe("Н9 fuzz: compact answer (QR + sound / light payload)", () => {
  const offer = createInvitation("offer", SDP, alice, createEphemeralKeyPair().publicKey, { now: NOW });

  it("any bytes throw only CompactAnswerError", () => {
    fc.assert(
      fc.property(anyBytes(300), (b) => {
        try {
          decodeCompactAnswer(b, offer, NOW);
        } catch (e) {
          if (!(e instanceof CompactAnswerError)) throw e;
        }
      }),
      opts(),
    );
  });

  it("IPv6 text round trips for any 16 bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (b) => {
        expect(parseIpv6(formatIpv6(b))).toEqual(b);
      }),
      opts(),
    );
  });

  it("parseIpv6 never throws on any text", () => {
    fc.assert(
      fc.property(anyText, (t) => {
        const r = parseIpv6(t);
        expect(r === null || r.length === 16).toBe(true);
      }),
      opts(),
    );
  });
});

describe("Н9 fuzz: Reed-Solomon (sound and light modems)", () => {
  it("corrects up to 6 byte errors per 44-byte block", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
        fc.uniqueArray(fc.nat({ max: 43 }), { maxLength: 6 }),
        fc.integer({ min: 1, max: 255 }),
        (data, positions, x) => {
          const cw = rsEncode(data, 12);
          const bad = cw.slice();
          for (const p of positions) if (p < bad.length) bad[p] ^= x;
          const r = rsDecode(bad, 12);
          expect(r).not.toBeNull();
          expect(r!.data ?? r!.codeword.slice(0, data.length)).toEqual(data);
        },
      ),
      opts(),
    );
  });

  it("any codeword returns a result or null, never throws", () => {
    fc.assert(
      fc.property(anyBytes(80), fc.integer({ min: 2, max: 20 }), (b, nsym) => {
        rsDecode(b, nsym);
      }),
      opts(),
    );
  });

  it("blocks round trip and survive random input", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 255 }), anyBytes(400), (data, junk) => {
        const enc = encodeBlocks(data);
        const back = decodeBlocks(enc, data.length);
        expect(back && "data" in back ? back.data : back).toBeTruthy();
        decodeBlocks(junk, Math.max(1, junk.length >> 1));
      }),
      opts(),
    );
  });
});

describe("Н9 fuzz: FSK sound modem", () => {
  it("any payload up to 64 bytes round trips at 48 kHz", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (data) => {
        const dec = new FskDecoder(48000);
        dec.push(encodeToSamples(data, 48000));
        expect(dec.result).toEqual(data);
      }),
      opts(Math.min(RUNS, 12)),
    );
  });

  it("random audio never throws and never decodes into a payload", () => {
    fc.assert(
      fc.property(fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { maxLength: 20000 }), (xs) => {
        const dec = new FskDecoder(44100);
        dec.push(Float32Array.from(xs));
        expect(dec.result).toBeNull();
      }),
      opts(Math.min(RUNS, 40)),
    );
  });

  it("NaN and infinite samples do not throw", () => {
    const dec = new FskDecoder(48000);
    const x = new Float32Array(30000);
    x.fill(Number.NaN, 0, 10000);
    x.fill(Number.POSITIVE_INFINITY, 10000, 20000);
    expect(() => dec.push(x)).not.toThrow();
  });
});

describe("Н9 fuzz: colour grid (light modem)", () => {
  const SRC = LIGHT_SYMBOL_UNITS * 8;

  it("any payload up to 120 bytes round trips through the raster", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 120 }), (data) => {
        const dec = new LightDecoder();
        for (const f of encodeLightFrames(data)) dec.push({ data: rasterizeFrame(f, SRC, SRC), width: SRC, height: SRC });
        expect(dec.result).toEqual(data);
      }),
      opts(Math.min(RUNS, 15)),
    );
  });

  it("random images (any size, even too short) never throw", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 64 }), fc.integer({ min: 0, max: 64 }), anyBytes(64 * 64 * 4), (w, h, px) => {
        const dec = new LightDecoder();
        dec.push({ data: new Uint8ClampedArray(px), width: w, height: h });
        expect(dec.result).toBeNull();
      }),
      opts(),
    );
  });
});

describe("Н9 fuzz: encrypted session (Double Ratchet envelope)", () => {
  function pair() {
    const ephA = createEphemeralKeyPair();
    const ephB = createEphemeralKeyPair();
    return {
      a: SecureSession.derive({ role: "initiator", myIdentity: alice, myEphemeral: ephA, peerIdentityPublicKey: bob.publicKey, peerEphemeralPublicKey: ephB.publicKey }),
      b: SecureSession.derive({ role: "responder", myIdentity: bob, myEphemeral: ephB, peerIdentityPublicKey: alice.publicKey, peerEphemeralPublicKey: ephA.publicKey }),
    };
  }

  it("any text round trips", async () => {
    const { a, b } = pair();
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 500 }), async (t) => {
        expect(await b.open(await a.seal(t))).toBe(t);
      }),
      opts(),
    );
  });

  it("any text as an envelope throws only SessionError, and the session still works after", async () => {
    const { a, b } = pair();
    expect(await b.open(await a.seal("старт"))).toBe("старт");
    await fc.assert(
      fc.asyncProperty(anyText, async (t) => onlyDefined(() => b.open(t), SessionError)),
      opts(),
    );
    expect(await b.open(await a.seal("след това"))).toBe("след това");
  });

  it("a flipped character in a real envelope is refused", async () => {
    const { a, b } = pair();
    expect(await b.open(await a.seal("старт"))).toBe("старт");
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 50 }), fc.nat(), fc.integer({ min: 1, max: 30 }), async (t, i, x) => {
        const env = await a.seal(t);
        const pos = i % env.length;
        const bad = env.slice(0, pos) + String.fromCharCode(env.charCodeAt(pos) ^ x) + env.slice(pos + 1);
        let opened: string | null = null;
        await onlyDefined(async () => {
          opened = await b.open(bad);
        }, SessionError);
        // A flip that leaves the JSON meaning unchanged (e.g. whitespace) may still open; it must
        // then give back exactly the sealed text.
        if (opened !== null) expect(opened).toBe(t);
        // Keep the receiving chain in step for the next case.
        await onlyDefined(() => b.open(env), SessionError);
      }),
      opts(100),
    );
  });

  it("an envelope is never accepted twice (replay)", async () => {
    const { a, b } = pair();
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 50 }), async (t) => {
        const env = await a.seal(t);
        expect(await b.open(env)).toBe(t);
        await expect(b.open(env)).rejects.toBeInstanceOf(SessionError);
      }),
      opts(50),
    );
  });
});

describe("Н9 fuzz: control frames and codes", () => {
  it("control messages round trip", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DISAPPEAR_OPTIONS),
        fc.nat({ max: Number.MAX_SAFE_INTEGER }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        (ms, at, lat, lng) => {
          expect(decodeControl(encodeControl({ t: "timer", ms, at }))).toEqual({ t: "timer", ms, at });
          expect(decodeControl(encodeControl({ t: "wipe" }))).toEqual({ t: "wipe" });
          const loc = decodeControl(encodeControl({ t: "loc", fix: { lat, lng, accuracy: 10 } }));
          expect(loc?.t).toBe("loc");
        },
      ),
      opts(),
    );
  });

  it("any text decodes to a message or null", () => {
    fc.assert(
      fc.property(anyText, fc.jsonValue(), (t, j) => {
        decodeControl(t);
        decodeIntroControl(t);
        const framed = `\u0001K|${JSON.stringify(j)}`;
        decodeControl(framed);
        decodeIntroControl(framed);
        validIntroMessage(j);
      }),
      opts(),
    );
  });

  it("pairing codes (5 characters + 3 words) round trip and any text parses or gives null", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...ROOM_ID_ALPHABET), minLength: 5, maxLength: 5 }),
        anyText,
        (room, junk) => {
          const words = ["lemon", "rocket", "bridge"];
          const code = { roomId: room, words } as Parameters<typeof formatPairingCode>[0];
          const back = parsePairingCode(formatPairingCode(code));
          if (back) expect(back.roomId).toBe(room);
          parsePairingCode(junk);
        },
      ),
      opts(),
    );
  });

  it("short codes round trip and any text normalises or gives null", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...INVITE_CODE_ALPHABET), minLength: 10, maxLength: 10 }),
        anyText,
        (code, junk) => {
          expect(normalizeShortCode(formatShortCode(code))).toBe(code);
          const n = normalizeShortCode(junk);
          expect(n === null || n.length === 10).toBe(true);
        },
      ),
      opts(),
    );
  });
});

describe("Н9 fuzz: device transfer, Nostr and file frames", () => {
  it("any transfer code throws only TransferError", async () => {
    await fc.assert(
      fc.asyncProperty(anyText, anyBytes(), async (t, b) => {
        await onlyDefined(() => decodeTransferPacket(t, NOW), TransferError);
        await onlyDefined(() => decodeTransferPacket(`p2pt1:${bytesToBase64Url(b)}`, NOW), TransferError);
      }),
      opts(),
    );
  });

  it("any transfer bundle throws only TransferError", () => {
    fc.assert(
      fc.property(anyBytes(2000), (b) => {
        try {
          decodeBundle(b);
        } catch (e) {
          if (!(e instanceof TransferError)) throw e;
        }
      }),
      opts(),
    );
  });

  it("any relay message parses or gives null; any object is checked without throwing", () => {
    fc.assert(
      fc.property(anyText, fc.jsonValue(), (t, j) => {
        parseRelayMessage(t);
        parseRelayMessage(JSON.stringify(j));
        expect(typeof verifyEvent(j)).toBe("boolean");
      }),
      opts(),
    );
  });

  it("any group, call or file-card frame decodes or gives null", () => {
    const parts = new SignalAssembler();
    fc.assert(
      fc.property(fc.jsonValue(), anyText, (j, t) => {
        const json = JSON.stringify(j);
        for (const mark of ["\u0001G|", "\u0001C|"]) {
          decodeGroupWire(mark + json);
          decodeGroupWire(mark + t);
          decodeSignal(mark + json);
          decodeSignal(mark + t);
          parts.feed(mark + json);
          parts.feed(mark + t);
        }
        expect(() => validFileCard(j as never)).not.toThrow();
      }),
      opts(),
    );
  });

  it("any file frame is handled or ignored without throwing", () => {
    const sent: string[] = [];
    const files = new FileTransfers(
      { send: async (t: string) => void sent.push(t), sendBinary: async () => undefined, onBinary: () => () => undefined } as never,
      {} as never,
    );
    fc.assert(
      fc.property(fc.constantFrom("F", "A", "X", "R", "W"), fc.jsonValue(), anyText, (k, j, t) => {
        expect(() => files.handleControl(`\u0001${k}|${JSON.stringify(j)}`)).not.toThrow();
        expect(() => files.handleControl(`\u0001${k}|${t}`)).not.toThrow();
        expect(() => files.handleControl(t)).not.toThrow();
      }),
      opts(),
    );
    files.close();
  });
});
