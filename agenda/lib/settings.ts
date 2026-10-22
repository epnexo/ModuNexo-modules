import { getDb } from "@modunexo/sdk";
import type { Checked } from "./check.ts";
import { isTimeZone } from "./time.ts";

const MODULE = "agenda";

export type Settings = { timezone: string; slotMinutes: number; bufferMinutes: number; horizonDays: number };
export type Window = { weekday: number; startMinute: number; endMinute: number };

export async function loadSettings(): Promise<Settings> {
  const found = await getDb(MODULE).query<{ timezone: string; slot_minutes: number; buffer_minutes: number; horizon_days: number }>("select timezone, slot_minutes, buffer_minutes, horizon_days from settings where id = 1");
  const row = found.rows[0]!;
  return { timezone: row.timezone, slotMinutes: row.slot_minutes, bufferMinutes: row.buffer_minutes, horizonDays: row.horizon_days };
}

export async function loadHours(): Promise<Window[]> {
  const found = await getDb(MODULE).query<{ weekday: number; start_minute: number; end_minute: number }>("select weekday, start_minute, end_minute from weekly_hours order by weekday, start_minute");
  return found.rows.map((row) => ({ weekday: row.weekday, startMinute: row.start_minute, endMinute: row.end_minute }));
}

const whole = (raw: string | undefined, field: string, min: number, max: number): Checked<number> => {
  const text = raw?.trim() ?? "";
  const value = /^\d{1,4}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= min && value <= max)) return { ok: false, error: `"${field}" must be a whole number from ${min} to ${max}.` };
  return { ok: true, value };
};

/** The windows must be valid and, inside one day, must not overlap (they may touch). */
export function hoursInput(windows: Window[]): Checked<Window[]> {
  for (const w of windows) {
    if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) return { ok: false, error: '"weekday" must be 0 (Sunday) to 6.' };
    if (!(w.startMinute >= 0 && w.startMinute <= 1439 && w.endMinute >= 1 && w.endMinute <= 1440 && w.endMinute > w.startMinute)) return { ok: false, error: "A window must start and end inside the day, the end after the start." };
  }
  const sorted = [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (let index = 1; index < sorted.length; index += 1) {
    const before = sorted[index - 1]!;
    const now = sorted[index]!;
    if (before.weekday === now.weekday && now.startMinute < before.endMinute) return { ok: false, error: "Two windows of the same day overlap." };
  }
  return { ok: true, value: sorted };
}

const CLOCK = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
const minutesOf = (text: string): number => {
  const [h, m] = text.split(":");
  return Number(h) * 60 + Number(m);
};

/** Reads the settings form: the numbers, the zone and, for each weekday `d<n>_start` and `d<n>_end` as HH:MM (both blank means closed). */
export function settingsInput(raw: Record<string, string | undefined>): Checked<{ settings: Settings; hours: Window[] }> {
  const timezone = raw.timezone?.trim() ?? "";
  if (!isTimeZone(timezone)) return { ok: false, error: '"timezone" must be an IANA zone such as America/Bogota.' };
  const slot = whole(raw.slotMinutes, "slotMinutes", 5, 480);
  if (!slot.ok) return slot;
  const buffer = whole(raw.bufferMinutes, "bufferMinutes", 0, 240);
  if (!buffer.ok) return buffer;
  const horizon = whole(raw.horizonDays, "horizonDays", 1, 90);
  if (!horizon.ok) return horizon;
  const windows: Window[] = [];
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const start = raw[`d${weekday}_start`]?.trim() ?? "";
    const end = raw[`d${weekday}_end`]?.trim() ?? "";
    if (start === "" && end === "") continue;
    if (start === "" || !CLOCK.test(start) || start === "24:00") return { ok: false, error: `"d${weekday}_start" must be a time like 09:00.` };
    if (end === "" || !CLOCK.test(end)) return { ok: false, error: `"d${weekday}_end" must be a time like 17:00.` };
    if (minutesOf(end) <= minutesOf(start)) return { ok: false, error: `"d${weekday}_end" must be after the start.` };
    windows.push({ weekday, startMinute: minutesOf(start), endMinute: minutesOf(end) });
  }
  const hours = hoursInput(windows);
  if (!hours.ok) return hours;
  return { ok: true, value: { settings: { timezone, slotMinutes: slot.value, bufferMinutes: buffer.value, horizonDays: horizon.value }, hours: hours.value } };
}

/** Replaces the settings and every window in one transaction. Bookings already made are left alone. */
export async function saveSettings(settings: Settings, hours: Window[]): Promise<void> {
  await getDb(MODULE).transaction(async (tx) => {
    await tx.query("update settings set timezone = $1, slot_minutes = $2, buffer_minutes = $3, horizon_days = $4, updated_at = now() where id = 1", [settings.timezone, settings.slotMinutes, settings.bufferMinutes, settings.horizonDays]);
    await tx.query("delete from weekly_hours");
    for (const w of hours) await tx.query("insert into weekly_hours (weekday, start_minute, end_minute) values ($1, $2, $3)", [w.weekday, w.startMinute, w.endMinute]);
  });
}
