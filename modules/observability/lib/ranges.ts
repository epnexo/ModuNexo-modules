export type Range = "1h" | "24h" | "7d" | "30d" | "90d";

export interface RangeSpec {
  label: string;
  /** How far back the chart goes. */
  ms: number;
  /** One point every this many milliseconds, which sets how long a silence has to be to break the line. */
  stepMs: number;
  /** Where the points come from: raw samples, the hourly rollups or the daily rollups (raw is kept 14 days, hourly 180). */
  source: "raw" | "hourly" | "daily";
  /** Width in seconds of the buckets the points are averaged into; 0 keeps every raw sample. */
  bucketSeconds: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGES: Record<Range, RangeSpec> = {
  "1h": { label: "1 hour", ms: HOUR, stepMs: 60_000, source: "raw", bucketSeconds: 0 },
  "24h": { label: "24 hours", ms: DAY, stepMs: 600_000, source: "raw", bucketSeconds: 600 },
  "7d": { label: "7 days", ms: 7 * DAY, stepMs: HOUR, source: "hourly", bucketSeconds: 3600 },
  "30d": { label: "30 days", ms: 30 * DAY, stepMs: 6 * HOUR, source: "hourly", bucketSeconds: 21_600 },
  "90d": { label: "90 days", ms: 90 * DAY, stepMs: DAY, source: "daily", bucketSeconds: 86_400 },
};

export const DEFAULT_RANGE: Range = "24h";

/** The range named by a query parameter, or the default for anything unknown. */
export function parseRange(raw: string | string[] | undefined): Range {
  return typeof raw === "string" && Object.hasOwn(RANGES, raw) ? (raw as Range) : DEFAULT_RANGE;
}
