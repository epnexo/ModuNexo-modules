import { zonedParts } from "../lib/time.ts";

export const INPUT = "rounded-md border border-border-strong bg-surface px-3 py-2 outline-none focus-visible:border-accent";
export const BUTTON = "h-10 self-start rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover";
export const BUTTON_QUIET = "h-9 self-start rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-accent-soft";
export const BUTTON_DANGER = "h-9 self-start rounded-md border border-border-strong px-3 text-sm text-danger transition-colors duration-150 hover:bg-accent-soft";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Mon 26 Oct` */
export const dayLabel = (d: { year: number; month: number; day: number }): string => `${WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]} ${d.day} ${MONTHS[d.month - 1]}`;

export const clock = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** `09:00` of an instant, on the wall clock of the zone. */
export const timeIn = (instant: Date, timeZone: string): string => clock(zonedParts(instant.getTime(), timeZone).minuteOfDay);

/** `Mon 26 Oct 09:00` */
export function slotLabel(instant: Date, timeZone: string): string {
  const p = zonedParts(instant.getTime(), timeZone);
  return `${dayLabel(p)} ${clock(p.minuteOfDay)}`;
}
