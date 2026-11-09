import { formatUtcDay } from "./format.ts";
import type { DailyRow } from "./queries.ts";

/** The interval one bar of the daily chart covers. Weeks start on Monday; everything is UTC. */
export const GRAINS = ["day", "week", "month"] as const;
export type Grain = (typeof GRAINS)[number];
export const DEFAULT_GRAIN: Grain = "day";

export const GRAIN_LABELS: Record<Grain, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const parseDay = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Read the `grain` query value. Anything unknown is the default, never trusted. */
export function parseGrain(value: string | string[] | undefined): Grain {
  const picked = Array.isArray(value) ? value[0] : value;
  return (GRAINS as readonly string[]).includes(picked ?? "") ? (picked as Grain) : DEFAULT_GRAIN;
}

/** The first day of the bucket holding `day`: the day itself, its Monday, or the first of its month. */
export function bucketStart(day: string, grain: Grain): string {
  if (grain === "day") return day;
  if (grain === "month") return `${day.slice(0, 7)}-01`;
  const ms = parseDay(day);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  return isoDay(ms - sinceMonday * DAY_MS);
}

/** Every bucket from the one holding `from` to the one holding `to`, so a quiet bucket shows as a gap. */
export function bucketSeries(from: string, to: string, grain: Grain): string[] {
  const last = bucketStart(to, grain);
  const out: string[] = [];
  let at = bucketStart(from, grain);
  while (at <= last) {
    out.push(at);
    if (grain === "day") at = isoDay(parseDay(at) + DAY_MS);
    else if (grain === "week") at = isoDay(parseDay(at) + 7 * DAY_MS);
    else {
      const next = new Date(parseDay(at));
      next.setUTCMonth(next.getUTCMonth() + 1);
      at = isoDay(next.getTime());
    }
  }
  return out;
}

/** Daily rows summed into buckets, one row per bucket and tool. Days are returned as they are. */
export function bucketDaily(rows: DailyRow[], grain: Grain): DailyRow[] {
  if (grain === "day") return rows;
  const sums = new Map<string, DailyRow>();
  for (const row of rows) {
    const day = bucketStart(row.day, grain);
    const key = `${day}|${row.tool}`;
    const known = sums.get(key);
    if (known) known.totalTokens += row.totalTokens;
    else sums.set(key, { day, tool: row.tool, totalTokens: row.totalTokens });
  }
  return [...sums.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.tool < b.tool ? -1 : 1));
}

/** What a bucket is called in a tooltip, a table and a screen reader label. */
export function bucketTitle(bucket: string, grain: Grain): string {
  if (grain === "week") return `Week of ${formatUtcDay(bucket)}`;
  if (grain === "month") return `${MONTHS[Number(bucket.slice(5, 7)) - 1]} ${bucket.slice(0, 4)}`;
  return formatUtcDay(bucket);
}

/** The short label under a bar: the day or week start as "9 Nov", the month as "Nov". */
export function bucketAxisLabel(bucket: string, grain: Grain, dayShort: (day: string) => string): string {
  return grain === "month" ? MONTHS[Number(bucket.slice(5, 7)) - 1]! : dayShort(bucket);
}
