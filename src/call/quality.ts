/**
 * Call quality (Н6): what getStats() says about the link, a three-level rating for the
 * screen, and the step the outgoing video should be at. Pure functions, so they are tested
 * without a browser; callController.ts feeds them every STATS_MS.
 */
export const STATS_MS = 2000;

export interface CallStats {
  /** Round-trip time of the active candidate pair, ms. */
  rttMs: number | null;
  /** Share of incoming RTP packets lost in the last interval, percent. */
  lossPct: number | null;
  inKbps: number | null;
  outKbps: number | null;
}

export type Quality = "good" | "fair" | "poor" | "unknown";

export function rateQuality(s: CallStats): Quality {
  if (s.rttMs === null && s.lossPct === null) return "unknown";
  const loss = s.lossPct ?? 0;
  const rtt = s.rttMs ?? 0;
  if (loss > 8 || rtt > 500) return "poor";
  if (loss > 2 || rtt > 250) return "fair";
  return "good";
}

/** Outgoing video steps, best first. */
export const VIDEO_STEPS = [
  { maxBitrate: 1_500_000, scaleResolutionDownBy: 1 },
  { maxBitrate: 600_000, scaleResolutionDownBy: 2 },
  { maxBitrate: 250_000, scaleResolutionDownBy: 4 },
] as const;

/** Good quality must hold this long before the video goes one step up again. */
export const STEP_UP_AFTER_MS = 10_000;

/** Down one step at once on a poor link; up one step after STEP_UP_AFTER_MS of good. */
export function nextVideoStep(current: number, quality: Quality, goodForMs: number): number {
  const last = VIDEO_STEPS.length - 1;
  if (quality === "poor") return Math.min(current + 1, last);
  if (quality === "good" && goodForMs >= STEP_UP_AFTER_MS) return Math.max(current - 1, 0);
  return current;
}

/** Counters kept between two getStats() calls. */
export interface StatsSample {
  at: number;
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  lostIn: number;
}

interface StatLike {
  type: string;
  [k: string]: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Reads one getStats() report (any iterable of stat objects) against the previous sample.
 * Only media RTP counts for loss and bitrate; the data channel is not RTP.
 */
export function summarizeStats(report: Iterable<StatLike>, prev: StatsSample | null, now: number): { stats: CallStats; sample: StatsSample } {
  let rtt: number | null = null;
  const sample: StatsSample = { at: now, bytesIn: 0, bytesOut: 0, packetsIn: 0, lostIn: 0 };
  for (const s of report) {
    if (s.type === "candidate-pair" && (s.nominated === true || s.selected === true) && s.state === "succeeded") {
      const r = num(s.currentRoundTripTime);
      if (r !== null) rtt = Math.round(r * 1000);
    } else if (s.type === "inbound-rtp") {
      sample.bytesIn += num(s.bytesReceived) ?? 0;
      sample.packetsIn += num(s.packetsReceived) ?? 0;
      sample.lostIn += Math.max(0, num(s.packetsLost) ?? 0);
    } else if (s.type === "outbound-rtp") {
      sample.bytesOut += num(s.bytesSent) ?? 0;
    }
  }
  if (!prev || now <= prev.at) return { stats: { rttMs: rtt, lossPct: null, inKbps: null, outKbps: null }, sample };
  const secs = (now - prev.at) / 1000;
  const received = sample.packetsIn - prev.packetsIn;
  const lost = sample.lostIn - prev.lostIn;
  const lossPct = received + lost > 0 ? Math.max(0, Math.min(100, (lost / (received + lost)) * 100)) : null;
  const kbps = (bytes: number) => (bytes >= 0 ? Math.round((bytes * 8) / 1000 / secs) : null);
  return {
    stats: {
      rttMs: rtt,
      lossPct: lossPct === null ? null : Math.round(lossPct * 10) / 10,
      inKbps: kbps(sample.bytesIn - prev.bytesIn),
      outKbps: kbps(sample.bytesOut - prev.bytesOut),
    },
    sample,
  };
}
