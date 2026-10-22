import { getDb } from "@modunexo/sdk";
import { loadHours, loadSettings, type Settings, type Window } from "./settings.ts";
import { addDays, localToUtc, zonedParts, weekdayOf } from "./time.ts";

export type Slot = { startsAt: Date; endsAt: Date };
export type Busy = { startsAt: Date; endsAt: Date };

const MINUTE = 60_000;

/**
 * The free slots, oldest first. Each window is cut into slots of `slotMinutes` from its start; a slot must end inside the
 * window, start after `now`, fall within the horizon (today is the first day, by the date in the settings' zone) and keep
 * at least `bufferMinutes` from every booking. A local time the clock skips is left out; one it shows twice counts once.
 */
export function computeSlots(input: { settings: Settings; hours: Window[]; busy: Busy[]; now: Date }): Slot[] {
  const { settings, hours, busy, now } = input;
  const slotMs = settings.slotMinutes * MINUTE;
  const bufferMs = settings.bufferMinutes * MINUTE;
  const today = zonedParts(now.getTime(), settings.timezone);
  const found = new Map<number, Slot>();
  for (let offset = 0; offset < settings.horizonDays; offset += 1) {
    const day = addDays(today.year, today.month, today.day, offset);
    const weekday = weekdayOf(day.year, day.month, day.day);
    for (const window of hours) {
      if (window.weekday !== weekday) continue;
      for (let minute = window.startMinute; minute + settings.slotMinutes <= window.endMinute; minute += settings.slotMinutes) {
        const start = localToUtc(day.year, day.month, day.day, minute, settings.timezone);
        if (start === null || start <= now.getTime()) continue;
        const end = start + slotMs;
        const clash = busy.some((other) => start < other.endsAt.getTime() + bufferMs && other.startsAt.getTime() < end + bufferMs);
        if (!clash) found.set(start, { startsAt: new Date(start), endsAt: new Date(end) });
      }
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot);
}

/** The bookings that are still on, which are what a new slot has to keep away from. */
export async function loadBusy(): Promise<Busy[]> {
  const found = await getDb("agenda").query<{ starts_at: Date; ends_at: Date }>("select starts_at, ends_at from bookings where status = 'booked' and ends_at > now() - interval '1 day'");
  return found.rows.map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at }));
}

export async function freeSlots(now: Date = new Date()): Promise<Slot[]> {
  const [settings, hours, busy] = await Promise.all([loadSettings(), loadHours(), loadBusy()]);
  return computeSlots({ settings, hours, busy, now });
}
