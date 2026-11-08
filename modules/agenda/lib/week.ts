import { addDays, localToUtc, weekdayOf, zonedParts } from "./time.ts";

export type Day = { year: number; month: number; day: number };
export type Week = { days: Day[]; from: Date; to: Date; prev: string; next: string };

/** `YYYY-MM-DD` as a calendar date, or null when it is not one (also for a date that does not exist, like 2026-02-30). */
export function parseDay(raw: string | string[] | undefined): Day | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? { year, month, day } : null;
}

export const formatDay = (d: Day): string => `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** The first instant of a local day: midnight, or the first minute that exists when the clock skips midnight. */
function startOfDay(d: Day, timeZone: string): Date {
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const at = localToUtc(d.year, d.month, d.day, minute, timeZone);
    if (at !== null) return new Date(at);
  }
  return new Date(Date.UTC(d.year, d.month - 1, d.day));
}

/**
 * The Monday-to-Sunday week that holds `raw` (or today in the zone, when `raw` is missing or not a date): its seven days,
 * the instants where it starts and ends in the zone, and the day parameters of the weeks before and after.
 */
export function weekOf(raw: string | string[] | undefined, now: Date, timeZone: string): Week {
  const today = zonedParts(now.getTime(), timeZone);
  const asked = parseDay(raw) ?? { year: today.year, month: today.month, day: today.day };
  const sinceMonday = (weekdayOf(asked.year, asked.month, asked.day) + 6) % 7;
  const monday = addDays(asked.year, asked.month, asked.day, -sinceMonday);
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday.year, monday.month, monday.day, index));
  const nextMonday = addDays(monday.year, monday.month, monday.day, 7);
  return { days, from: startOfDay(monday, timeZone), to: startOfDay(nextMonday, timeZone), prev: formatDay(addDays(monday.year, monday.month, monday.day, -7)), next: formatDay(nextMonday) };
}
