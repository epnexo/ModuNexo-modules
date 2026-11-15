/**
 * What a host's history says beyond the live numbers: this week against the last one, when the disk will be full and
 * the hours that stood out. Everything here is pure; the rollups it reads are loaded in queries.ts. A trend that has
 * too little history to be honest says so instead of guessing.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** One complete UTC day of a metric: `t` is the start of the day in epoch milliseconds, `avg` its mean. */
export interface DayPoint { t: number; avg: number }
/** One hour of a metric: its mean and the highest value reached in it. */
export interface HourPoint { t: number; avg: number; max: number }

/** The metrics compared week over week, in the order they are shown. */
export const WEEK_METRICS = ["cpuPercent", "memUsedPercent", "diskUsedPercent", "tempCelsius"] as const;
/** Each week needs this many days of data before it is compared. */
export const MIN_DAYS_PER_WEEK = 4;

export interface WeekComparison { current: number; previous: number; change: number; percent: number | null }

const startOfDay = (now: number): number => Math.floor(now / DAY) * DAY;
const mean = (values: number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

/** The mean of the last seven complete days against the seven before, or null when either has too few days. */
export function compareWeeks(days: DayPoint[], now: number): WeekComparison | null {
  const end = startOfDay(now);
  const current = days.filter((day) => day.t >= end - 7 * DAY && day.t < end).map((day) => day.avg);
  const previous = days.filter((day) => day.t >= end - 14 * DAY && day.t < end - 7 * DAY).map((day) => day.avg);
  if (current.length < MIN_DAYS_PER_WEEK || previous.length < MIN_DAYS_PER_WEEK) return null;
  const now7 = mean(current);
  const before7 = mean(previous);
  const change = now7 - before7;
  return { current: now7, previous: before7, change, percent: before7 === 0 ? null : (change / Math.abs(before7)) * 100 };
}

export const MIN_FORECAST_DAYS = 3;
/** A disk that grows by less than this many points a day is not going anywhere. */
const MIN_GROWTH_PER_DAY = 0.05;
/** A forecast further out than this is noise, so the disk is called stable. */
const MAX_FORECAST_DAYS = 365;

export type DiskForecast =
  | { state: "unknown"; daysOfData: number; needed: number }
  | { state: "stable" }
  | { state: "filling"; perDay: number; daysLeft: number; fullOn: number };

/** Fits a line to the last two weeks of daily disk usage and says when it reaches `ceiling` percent. */
export function forecastFull(days: DayPoint[], now: number, ceiling = 100): DiskForecast {
  const end = startOfDay(now);
  const recent = days.filter((day) => day.t >= end - 14 * DAY && day.t < end).sort((a, b) => a.t - b.t);
  const first = recent[0];
  const last = recent.at(-1);
  if (first === undefined || last === undefined || recent.length < MIN_FORECAST_DAYS) return { state: "unknown", daysOfData: recent.length, needed: MIN_FORECAST_DAYS };
  const xs = recent.map((day) => (day.t - first.t) / DAY);
  const meanX = mean(xs);
  const meanY = mean(recent.map((day) => day.avg));
  const spread = xs.reduce((total, x) => total + (x - meanX) ** 2, 0);
  const slope = spread === 0 ? 0 : xs.reduce((total, x, index) => total + (x - meanX) * (recent[index]!.avg - meanY), 0) / spread;
  if (last.avg >= ceiling) return { state: "filling", perDay: Math.max(slope, 0), daysLeft: 0, fullOn: now };
  if (slope < MIN_GROWTH_PER_DAY) return { state: "stable" };
  const daysLeft = (ceiling - last.avg) / slope;
  if (daysLeft > MAX_FORECAST_DAYS) return { state: "stable" };
  return { state: "filling", perDay: slope, daysLeft, fullOn: now + daysLeft * DAY };
}

/** The least rise above the usual level, per metric, that is worth calling a spike. */
export const SPIKE_METRICS: Record<string, number> = { cpuPercent: 25, memUsedPercent: 15, tempCelsius: 8 };
const SPIKE_HISTORY_HOURS = 24;
const MIN_SPIKE_HISTORY = 12;
export const MAX_SPIKES = 5;

export interface Spike { metric: string; t: number; value: number; usual: number }

/** Hours of the last day whose peak is well above what the 24 hours before them looked like, newest first. */
export function findSpikes(metric: string, hours: HourPoint[], now: number): Spike[] {
  const minJump = SPIKE_METRICS[metric];
  if (minJump === undefined) return [];
  const found: Spike[] = [];
  for (const hour of hours) {
    if (hour.t < now - SPIKE_HISTORY_HOURS * HOUR) continue;
    const before = hours.filter((other) => other.t >= hour.t - SPIKE_HISTORY_HOURS * HOUR && other.t < hour.t).map((other) => other.avg);
    if (before.length < MIN_SPIKE_HISTORY) continue;
    const usual = mean(before);
    const spread = Math.sqrt(mean(before.map((value) => (value - usual) ** 2)));
    if (hour.max - usual > Math.max(3 * spread, minJump)) found.push({ metric, t: hour.t, value: hour.max, usual });
  }
  return found.sort((a, b) => b.t - a.t);
}

export interface HostTrends {
  weeks: Array<WeekComparison & { metric: string }>;
  disk: DiskForecast;
  spikes: Spike[];
}

/** Every trend of one host from its daily and hourly rollups, keyed by metric. */
export function buildTrends(daily: Record<string, DayPoint[]>, hourly: Record<string, HourPoint[]>, now: number): HostTrends {
  const weeks = WEEK_METRICS.flatMap((metric) => {
    const comparison = compareWeeks(daily[metric] ?? [], now);
    return comparison === null ? [] : [{ metric, ...comparison }];
  });
  const spikes = Object.keys(SPIKE_METRICS).flatMap((metric) => findSpikes(metric, hourly[metric] ?? [], now)).sort((a, b) => b.t - a.t).slice(0, MAX_SPIKES);
  return { weeks, disk: forecastFull(daily.diskUsedPercent ?? [], now), spikes };
}
