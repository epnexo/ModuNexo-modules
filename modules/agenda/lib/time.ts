/** Calendar and clock arithmetic in an IANA zone, with Intl only (no library). Months are 1 to 12 and weekdays 0 (Sunday) to 6. */

export type Zoned = { year: number; month: number; day: number; minuteOfDay: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, found);
  }
  return found;
}

export function isTimeZone(name: string): boolean {
  if (name.trim() === "" || name !== name.trim()) return false;
  try {
    formatter(name);
    return Intl.supportedValuesOf("timeZone").includes(name) || name === "UTC";
  } catch {
    return false;
  }
}

function partsOf(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== "literal") out[part.type] = Number(part.value);
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour!, minute: out.minute!, second: out.second! };
}

/** How far the zone's wall clock is ahead of UTC at that instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const p = partsOf(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

export const weekdayOf = (year: number, month: number, day: number): number => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

export function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

export function zonedParts(instant: number, timeZone: string): Zoned {
  const p = partsOf(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day, minuteOfDay: p.hour * 60 + p.minute, weekday: weekdayOf(p.year, p.month, p.day) };
}

/**
 * The instant at which the wall clock of `timeZone` reads that date and minute of the day. A time the clock skips (spring
 * forward) has no instant and gives null; a time it shows twice (autumn) gives the earlier one.
 */
export function localToUtc(year: number, month: number, day: number, minuteOfDay: number, timeZone: string): number | null {
  const asIfUtc = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const around = [offsetAt(asIfUtc - 86_400_000, timeZone), offsetAt(asIfUtc + 86_400_000, timeZone)];
  const valid = [...new Set(around.map((offset) => asIfUtc - offset))].filter((candidate) => offsetAt(candidate, timeZone) === asIfUtc - candidate);
  return valid.length === 0 ? null : Math.min(...valid);
}
