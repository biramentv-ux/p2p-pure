/**
 * BLE first-contact pairing: two phones exchange their signed p2p1 invitations over
 * Bluetooth Low Energy instead of scanning a QR code. BLE is only the signalling carrier;
 * WebRTC connects over the network afterwards and the safety-code check stays mandatory.
 *
 * Native plugin "BlePairing" (Android Java / iOS Swift) implements BlePairingPlugin.
 * Roles: INITIATOR (makes the offer) = BLE peripheral, RESPONDER = BLE central.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export const BLE_SERVICE_UUID = "3da7960c-96f3-4d14-a3c8-b842772e603e";
/** Central writes here (write with response). */
export const BLE_RX_UUID = "7b8af345-7943-48e4-9134-e268f787d5cf";
/** Peripheral notifies here. */
export const BLE_TX_UUID = "ae4c0870-c466-48e6-af14-d814739213db";

export const BLE_TAG_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const BLE_TAG_LENGTH = 4;
export const BLE_FRAME_VERSION = 1;
export const BLE_HEADER_BYTES = 7;
export const BLE_ATT_OVERHEAD = 3;
export const BLE_DEFAULT_MTU = 23;
export const BLE_MAX_MESSAGE_BYTES = 16 * 1024;
export const BLE_DEFAULT_TIMEOUT_MS = 60_000;

export interface BleDevice {
  deviceId: string;
  tag: string;
  rssi: number;
}

export type BleUnavailableReason = "unsupported" | "off" | "unauthorized";

export interface BlePairingPlugin {
  checkAvailability(): Promise<{ available: boolean; reason?: BleUnavailableReason }>;
  requestPermissions(): Promise<{ granted: boolean }>;
  startPeripheral(options: { tag: string }): Promise<void>;
  startScan(): Promise<void>;
  connect(options: { deviceId: string }): Promise<{ mtu: number }>;
  /** data is STANDARD base64. Peripheral: notify TX. Central: write RX. */
  send(options: { data: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(event: "deviceFound", fn: (e: BleDevice) => void): Promise<PluginListenerHandle>;
  addListener(event: "connected", fn: (e: { mtu: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "subscribed", fn: (e: { mtu: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "data", fn: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "disconnected", fn: (e: { reason?: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "error", fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const BlePairing = registerPlugin<BlePairingPlugin>("BlePairing");

export function isBleSupported(platform: string = Capacitor.getPlatform()): boolean {
  return platform === "android" || platform === "ios";
}

/** Error with a Bulgarian, user-facing message. */
export class BlePairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlePairingError";
  }
}

const MSG = {
  timeout: "Времето за сдвояване изтече.",
  off: "Bluetooth е изключен.",
  unauthorized: "Няма разрешение за Bluetooth.",
  unsupported: "Този телефон не поддържа Bluetooth Low Energy.",
  disconnected: "Връзката по Bluetooth прекъсна.",
  generic: "Грешка при Bluetooth.",
  badFrame: "Получен е повреден Bluetooth пакет.",
  tooBig: "Поканата е твърде голяма за Bluetooth.",
};

// ---------- random / tag ----------

function defaultRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 0x1_0000_0000;
}

/** 4-char tag from an unambiguous alphabet. `random` returns a float in [0, 1). */
export function newBleTag(random: () => number = defaultRandom): string {
  let tag = "";
  for (let i = 0; i < BLE_TAG_LENGTH; i++) {
    tag += BLE_TAG_ALPHABET[Math.floor(random() * BLE_TAG_ALPHABET.length) % BLE_TAG_ALPHABET.length];
  }
  return tag;
}

// ---------- standard base64 (native side uses STANDARD base64 with padding) ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(input: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(input);
  } catch {
    throw new BlePairingError(MSG.badFrame);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------- framing ----------

/** Payload bytes per frame for a negotiated MTU (min 1). */
export function payloadSize(mtu: number): number {
  return Math.max(1, Math.floor(mtu) - BLE_ATT_OVERHEAD - BLE_HEADER_BYTES);
}

/** Splits the UTF-8 bytes of `message` into frames: [ver u8][id u16 BE][index u16 BE][total u16 BE][payload]. */
export function encodeFrames(message: string, mtu: number, messageId: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(message);
  if (bytes.length > BLE_MAX_MESSAGE_BYTES) throw new BlePairingError(MSG.tooBig);
  const size = payloadSize(mtu);
  const total = Math.max(1, Math.ceil(bytes.length / size));
  if (total > 0xffff) throw new BlePairingError(MSG.tooBig);
  const id = messageId & 0xffff;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const chunk = bytes.subarray(i * size, (i + 1) * size);
    const frame = new Uint8Array(BLE_HEADER_BYTES + chunk.length);
    frame[0] = BLE_FRAME_VERSION;
    frame[1] = id >> 8;
    frame[2] = id & 0xff;
    frame[3] = i >> 8;
    frame[4] = i & 0xff;
    frame[5] = total >> 8;
    frame[6] = total & 0xff;
    frame.set(chunk, BLE_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

/** Reassembles frames of a single message. Throws BlePairingError on any violation. */
export class FrameAssembler {
  private id: number | null = null;
  private total = 0;
  private parts = new Map<number, Uint8Array>();
  private bytes = 0;

  get received(): number {
    return this.parts.size;
  }
  get expected(): number {
    return this.total;
  }

  push(frame: Uint8Array): string | null {
    if (frame.length < BLE_HEADER_BYTES || frame[0] !== BLE_FRAME_VERSION) {
      throw new BlePairingError(MSG.badFrame);
    }
    const id = (frame[1] << 8) | frame[2];
    const index = (frame[3] << 8) | frame[4];
    const total = (frame[5] << 8) | frame[6];
    if (total === 0 || index >= total) throw new BlePairingError(MSG.badFrame);
    if (this.id === null) {
      this.id = id;
      this.total = total;
    } else if (id !== this.id || total !== this.total) {
      throw new BlePairingError(MSG.badFrame);
    }
    if (this.parts.has(index)) throw new BlePairingError(MSG.badFrame);
    const payload = frame.slice(BLE_HEADER_BYTES);
    this.bytes += payload.length;
    if (this.bytes > BLE_MAX_MESSAGE_BYTES) throw new BlePairingError(MSG.tooBig);
    this.parts.set(index, payload);
    if (this.parts.size < this.total) return null;

    const all = new Uint8Array(this.bytes);
    let offset = 0;
    for (let i = 0; i < this.total; i++) {
      const part = this.parts.get(i)!;
      all.set(part, offset);
      offset += part.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      throw new BlePairingError(MSG.badFrame);
    }
  }
}

// ---------- session ----------

export interface BleStatus {
  phase: "starting" | "waiting" | "scanning" | "connecting" | "sending" | "receiving" | "processing" | "done";
  done?: number;
  total?: number;
}

export interface BleSessionOptions {
  timeoutMs?: number;
  /** Float in [0, 1); injectable for tests. */
  random?: () => number;
}

export interface InitiatorOptions {
  tag: string;
  offer: string;
  onAnswer: (answer: string) => void | Promise<void>;
  onStatus?: (s: BleStatus) => void;
}

export interface ResponderOptions {
  onDevices: (list: BleDevice[]) => void;
  onOffer: (offer: string) => Promise<string>;
  onStatus?: (s: BleStatus) => void;
}

type Settle = { resolve: () => void; reject: (e: Error) => void };

export class BlePairingSession {
  private readonly timeoutMs: number;
  private readonly random: () => number;
  private handles: PluginListenerHandle[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: Settle | null = null;
  private active = false;
  private cleanup: Promise<void> = Promise.resolve();
  private devices = new Map<string, BleDevice>();
  private pickHandler: ((deviceId: string) => Promise<void>) | null = null;

  private readonly plugin: BlePairingPlugin;

  constructor(plugin: BlePairingPlugin = BlePairing, opts: BleSessionOptions = {}) {
    this.plugin = plugin;
    this.timeoutMs = opts.timeoutMs ?? BLE_DEFAULT_TIMEOUT_MS;
    this.random = opts.random ?? defaultRandom;
  }

  /** Initiator = BLE peripheral. Resolves after the answer was delivered to onAnswer and BLE was stopped. */
  async startAsInitiator(o: InitiatorOptions): Promise<void> {
    const status = o.onStatus ?? (() => {});
    await this.begin(async (finish, fail) => {
      const assembler = new FrameAssembler();
      let sending = false;
      const guard = <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) =>
        (...a: A) => {
          if (!this.active) return;
          Promise.resolve()
            .then(() => fn(...a))
            .catch(fail);
        };
      await this.listen("subscribed", guard(async (e: { mtu?: number }) => {
        if (sending) return;
        sending = true;
        const frames = encodeFrames(o.offer, e?.mtu ?? BLE_DEFAULT_MTU, Math.floor(this.random() * 0x10000));
        for (let i = 0; i < frames.length; i++) {
          if (!this.active) return;
          status({ phase: "sending", done: i, total: frames.length });
          await this.plugin.send({ data: bytesToBase64(frames[i]) });
        }
        status({ phase: "waiting" });
      }));
      await this.listen("data", guard(async (e: { data: string }) => {
        status({ phase: "receiving", done: assembler.received + 1, total: assembler.expected });
        const answer = assembler.push(base64ToBytes(e.data));
        if (answer === null) return;
        status({ phase: "processing" });
        await o.onAnswer(answer);
        status({ phase: "done" });
        finish();
      }));
      await this.commonListeners(fail);
      status({ phase: "waiting" });
      await this.plugin.startPeripheral({ tag: o.tag });
    }, status);
  }

  /** Responder = BLE central. Resolves after the answer was sent and BLE was stopped. */
  async startAsResponder(o: ResponderOptions): Promise<void> {
    const status = o.onStatus ?? (() => {});
    this.devices.clear();
    await this.begin(async (finish, fail) => {
      const assembler = new FrameAssembler();
      let mtu = BLE_DEFAULT_MTU;
      let picked = false;
      let gotOffer = false;
      const guard = <A extends unknown[]>(fn: (...a: A) => Promise<void> | void) =>
        (...a: A) => {
          if (!this.active) return;
          Promise.resolve()
            .then(() => fn(...a))
            .catch(fail);
        };
      await this.listen("deviceFound", guard((d: BleDevice) => {
        this.devices.set(d.deviceId, { deviceId: d.deviceId, tag: d.tag, rssi: d.rssi });
        o.onDevices([...this.devices.values()].sort((a, b) => b.rssi - a.rssi));
      }));
      await this.listen("connected", guard((e: { mtu?: number }) => {
        if (e?.mtu) mtu = e.mtu;
      }));
      await this.listen("data", guard(async (e: { data: string }) => {
        if (!picked || gotOffer) return;
        status({ phase: "receiving", done: assembler.received + 1, total: assembler.expected });
        const offer = assembler.push(base64ToBytes(e.data));
        if (offer === null) return;
        gotOffer = true;
        status({ phase: "processing" });
        const answer = await o.onOffer(offer);
        const frames = encodeFrames(answer, mtu, Math.floor(this.random() * 0x10000));
        for (let i = 0; i < frames.length; i++) {
          if (!this.active) return;
          status({ phase: "sending", done: i, total: frames.length });
          await this.plugin.send({ data: bytesToBase64(frames[i]) });
        }
        status({ phase: "done" });
        finish();
      }));
      await this.commonListeners(fail);
      this.pickHandler = async (deviceId) => {
        if (!this.active || picked) return;
        picked = true;
        status({ phase: "connecting" });
        const res = await this.plugin.connect({ deviceId });
        if (res?.mtu) mtu = res.mtu;
        status({ phase: "receiving", done: 0, total: 0 });
      };
      status({ phase: "scanning" });
      await this.plugin.startScan();
    }, status);
  }

  /** Responder: connect to the device the user tapped. */
  async pick(deviceId: string): Promise<void> {
    if (!this.pickHandler) return;
    try {
      await this.pickHandler(deviceId);
    } catch (err) {
      this.failWith(err);
    }
  }

  /** Stops everything quietly; the pending start*() promise resolves. */
  cancel(): void {
    if (!this.active) return;
    this.finishNow();
  }

  // ---------- internals ----------

  private async begin(
    setup: (finish: () => void, fail: (e: unknown) => void) => Promise<void>,
    status: (s: BleStatus) => void,
  ): Promise<void> {
    await this.cleanup;
    if (this.active) throw new BlePairingError(MSG.generic);
    this.active = true;
    this.pickHandler = null;
    const done = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    done.catch(() => {});
    this.timer = setTimeout(() => this.failWith(new BlePairingError(MSG.timeout)), this.timeoutMs);
    status({ phase: "starting" });
    try {
      const avail = await this.plugin.checkAvailability();
      if (!this.active) return done;
      if (!avail.available) throw new BlePairingError(unavailableMessage(avail.reason));
      const perm = await this.plugin.requestPermissions();
      if (!this.active) return done;
      if (!perm.granted) throw new BlePairingError(MSG.unauthorized);
      await setup(
        () => this.finishNow(),
        (e) => this.failWith(e),
      );
    } catch (err) {
      this.failWith(err);
    }
    return done;
  }

  private async listen(event: string, fn: (e: never) => void): Promise<void> {
    const handle = await (this.plugin.addListener as (e: string, f: (e: never) => void) => Promise<PluginListenerHandle>)(
      event,
      fn,
    );
    if (this.active) this.handles.push(handle);
    else void handle.remove().catch(() => {});
  }

  private async commonListeners(fail: (e: unknown) => void): Promise<void> {
    await this.listen("disconnected", (() => {
      if (this.active) fail(new BlePairingError(MSG.disconnected));
    }) as never);
    await this.listen("error", ((e: { message?: string }) => {
      if (this.active) {
        fail(new BlePairingError(e?.message ? `${MSG.generic} (${e.message})` : MSG.generic));
      }
    }) as never);
  }

  private failWith(err: unknown): void {
    if (!this.active) return;
    const error = err instanceof Error ? err : new BlePairingError(MSG.generic);
    this.teardown(() => this.settle?.reject(error));
  }

  private finishNow(): void {
    if (!this.active) return;
    this.teardown(() => this.settle?.resolve());
  }

  private teardown(settleFn: () => void): void {
    this.active = false;
    this.pickHandler = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const handles = this.handles;
    this.handles = [];
    this.cleanup = (async () => {
      for (const h of handles) {
        try {
          await h.remove();
        } catch {
          /* ignore */
        }
      }
      try {
        await this.plugin.stop();
      } catch {
        /* ignore */
      }
      settleFn();
    })();
  }
}

function unavailableMessage(reason?: BleUnavailableReason): string {
  if (reason === "off") return MSG.off;
  if (reason === "unauthorized") return MSG.unauthorized;
  if (reason === "unsupported") return MSG.unsupported;
  return MSG.generic;
}
