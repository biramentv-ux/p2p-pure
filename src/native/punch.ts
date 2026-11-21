/**
 * П4 (experiment): UDP hole punching for the native shells, including "birthday" punching for a
 * cone NAT against a symmetric one, on the HyperDHT model:
 *
 *  - The symmetric side opens many sockets (256). Each sends a few packets to the cone side's
 *    public address. Its NAT gives each socket its own random public port, all bound for the
 *    cone side's address. These first packets go out with a low TTL: they open our own NAT and
 *    die on the way, so they do not reach (and confuse) the other side's NAT.
 *  - The cone side sends probes from its one socket to random ports of the symmetric side's
 *    public IP, each port once. Every probe opens the cone side's filter for that port. A probe
 *    that hits one of the 256 open ports reaches the matching socket, which answers, and the
 *    answer passes the filter the probe opened.
 *
 * With 256 sockets and 1,750 probes the chance of a hit is about 99.9 % (hitProbability). Two
 * cone sides simply punch towards each other's public endpoint. Two symmetric sides cannot be
 * punched this way (both ports unknown): that case needs a relay.
 *
 * Every packet carries a token derived from the session secret, so nobody else can answer in
 * the other side's place: a foreign packet is ignored. This module only decides what to send
 * where and recognises the answers; the sockets come from the native shell (src/native/bridge.ts)
 * or, in the lab, from Node.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesEqual } from "../p2p/invitation";

export type NatKind = "cone" | "symmetric" | "unknown";

export const BIRTHDAY_SOCKETS = 256;
export const BIRTHDAY_PROBES = 1750;
export const PROBE_INTERVAL_MS = 10;
/** Ports a NAT may hand out (the range Linux and most routers use is narrower; this is the upper bound). */
export const PORT_LOW = 1024;
export const PORT_HIGH = 65535;
/** TTL for the packets that only need to open our own NAT. */
export const OPENER_TTL = 2;

const MAGIC = new TextEncoder().encode("P2PUNCH1");
export const PUNCH_PACKET_BYTES = MAGIC.length + 1 + 16;
const KIND_PROBE = 1;
const KIND_ACK = 2;

/** The token both sides compute from the session secret; a different one per direction. */
export function punchToken(secret: Uint8Array, from: "A" | "B"): Uint8Array {
  return hmac(sha256, secret, new TextEncoder().encode(`p2p-native/punch/v1/${from}`)).slice(0, 16);
}

export function encodePunch(kind: "probe" | "ack", token: Uint8Array): Uint8Array {
  const out = new Uint8Array(PUNCH_PACKET_BYTES);
  out.set(MAGIC, 0);
  out[MAGIC.length] = kind === "probe" ? KIND_PROBE : KIND_ACK;
  out.set(token, MAGIC.length + 1);
  return out;
}

/** Recognises a punch packet with the expected token; anything else is null. */
export function decodePunch(b: Uint8Array, expectedToken: Uint8Array): "probe" | "ack" | null {
  if (b.length !== PUNCH_PACKET_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return null;
  const kind = b[MAGIC.length];
  if (kind !== KIND_PROBE && kind !== KIND_ACK) return null;
  if (!bytesEqual(b.subarray(MAGIC.length + 1), expectedToken)) return null;
  return kind === KIND_PROBE ? "probe" : "ack";
}

/** P(at least one of `probes` distinct random ports is among `sockets` open ones). */
export function hitProbability(sockets: number, probes: number, range = PORT_HIGH - PORT_LOW + 1): number {
  let miss = 1;
  for (let i = 0; i < probes && i < range; i++) miss *= Math.max(0, 1 - sockets / (range - i));
  return 1 - miss;
}

/** `count` distinct ports in [low, high], in random order (partial Fisher-Yates over the range). */
export function randomPorts(count: number, random: () => number, low = PORT_LOW, high = PORT_HIGH): number[] {
  const n = high - low + 1;
  const take = Math.min(count, n);
  const swapped = new Map<number, number>();
  const out: number[] = [];
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (n - i));
    const vi = swapped.get(i) ?? i;
    const vj = swapped.get(j) ?? j;
    swapped.set(j, vi);
    out.push(low + vj);
  }
  return out;
}

export type Strategy = "direct" | "birthday-cone" | "birthday-symmetric" | "impossible";

/** What this side does, from both sides' NAT kinds. */
export function chooseStrategy(me: NatKind, peer: NatKind): Strategy {
  if (me === "symmetric" && peer === "symmetric") return "impossible";
  if (me === "symmetric") return "birthday-symmetric";
  if (peer === "symmetric") return "birthday-cone";
  return "direct";
}

/** A UDP socket as the native shells (and Node in the lab) provide it. */
export interface PunchSocket {
  readonly localPort: number;
  send(bytes: Uint8Array, port: number, host: string, ttl?: number): void;
  onMessage(handler: (bytes: Uint8Array, port: number, host: string) => void): () => void;
  close(): void;
}

export interface PunchResult {
  socket: PunchSocket;
  remoteHost: string;
  remotePort: number;
  strategy: Strategy;
  ms: number;
}

export class PunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PunchError";
  }
}

export interface PunchArgs {
  /** "A" is the side that made the invitation; it decides the direction of the tokens. */
  side: "A" | "B";
  secret: Uint8Array;
  me: NatKind;
  peer: { host: string; port: number; nat: NatKind };
  /** The socket whose public endpoint we told the other side (STUN or a port mapping). */
  socket: PunchSocket;
  /** Opens one more socket (the symmetric side of a birthday punch needs many). */
  openSocket: () => Promise<PunchSocket>;
  timeoutMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Punches a hole to the other side. Resolves with the socket and remote endpoint that work in
 * both directions, or rejects with PunchError. Every socket not chosen is closed.
 */
export async function punch(args: PunchArgs): Promise<PunchResult> {
  const { side, secret, me, peer, socket } = args;
  const timeoutMs = args.timeoutMs ?? 25_000;
  const random = args.random ?? Math.random;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;
  const started = now();
  const strategy = chooseStrategy(me, peer.nat);
  if (strategy === "impossible") throw new PunchError("Both sides are behind symmetric NAT: no direct path without a relay.");

  const mine = punchToken(secret, side);
  const theirs = punchToken(secret, side === "A" ? "B" : "A");
  const probe = encodePunch("probe", mine);
  const ack = encodePunch("ack", mine);

  const sockets: PunchSocket[] = [socket];
  const offs: Array<() => void> = [];
  let done: PunchResult | null = null;
  let finish!: (r: PunchResult) => void;
  const finished = new Promise<PunchResult>((resolve) => (finish = resolve));

  const listen = (s: PunchSocket) => {
    offs.push(
      s.onMessage((bytes, port, host) => {
        if (done || host !== peer.host) return;
        const kind = decodePunch(bytes, theirs);
        if (!kind) return;
        // Answer every probe (the other side waits for our ack), and take the first path that
        // worked: a probe or an ack from them means packets now pass both ways on this pair.
        if (kind === "probe") s.send(ack, port, host);
        done = { socket: s, remoteHost: host, remotePort: port, strategy, ms: now() - started };
        finish(done);
      }),
    );
  };
  listen(socket);

  const deadline = started + timeoutMs;
  const sending = (async () => {
    if (strategy === "direct") {
      // Open our own NAT first with a packet that dies on the way, then knock.
      socket.send(probe, peer.port, peer.host, OPENER_TTL);
      await sleep(150);
      while (!done && now() < deadline) {
        socket.send(probe, peer.port, peer.host);
        await sleep(200);
      }
    } else if (strategy === "birthday-symmetric") {
      // Many sockets, each opening its own mapping towards the cone side's one endpoint.
      for (let i = 1; i < BIRTHDAY_SOCKETS && !done; i++) {
        const s = await args.openSocket();
        sockets.push(s);
        listen(s);
      }
      while (!done && now() < deadline) {
        for (const s of sockets) {
          if (done) break;
          s.send(probe, peer.port, peer.host, OPENER_TTL);
        }
        await sleep(1000);
      }
    } else {
      // birthday-cone: wait a moment for the other side's sockets to open, then probe random ports.
      await sleep(500);
      const ports = randomPorts(BIRTHDAY_PROBES, random);
      for (let i = 0; !done && now() < deadline; i = (i + 1) % ports.length) {
        socket.send(probe, ports[i], peer.host);
        await sleep(PROBE_INTERVAL_MS);
      }
    }
  })();

  // Every sending loop runs until a path is found or the deadline (by `now`) passes.
  const winner = await Promise.race([finished, sending.then(() => done)]);
  for (const off of offs) off();
  await sending.catch(() => undefined);
  for (const s of sockets) if (s !== winner?.socket) s.close();
  if (!winner) throw new PunchError("No path through the NATs in time.");
  // A few acks more: the other side may have missed the first one.
  for (let i = 0; i < 3; i++) winner.socket.send(ack, winner.remotePort, winner.remoteHost);
  return winner;
}
