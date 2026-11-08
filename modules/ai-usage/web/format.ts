/** Shown wherever a counter is unknown. An unknown value is never rendered as zero. */
export const NOT_AVAILABLE = "n/a";

const UNITS = ["K", "M", "B", "T"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** Compact token counts with three significant digits: 1.07B, 392M, 76.1M, 12.3K. */
export function formatCompact(value: number | null): string {
  if (value === null) return NOT_AVAILABLE;
  if (Math.abs(value) < 1000) return String(Math.round(value));

  let scaled = value / 1000;
  let unit = 0;
  while (Math.abs(scaled) >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  const digits = (n: number) => (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  let text = scaled.toFixed(digits(scaled));
  // 999.96K rounds to "1000" at three digits: move to the next unit instead of printing 1000K.
  if (Math.abs(Number(text)) >= 1000 && unit < UNITS.length - 1) {
    scaled /= 1000;
    unit += 1;
    text = scaled.toFixed(digits(scaled));
  }
  return `${trimZeros(text)}${UNITS[unit]}`;
}

const GROUPED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Full integer with thousands separators. The locale is fixed so server and browser agree. */
export function formatCount(value: number | null): string {
  return value === null ? NOT_AVAILABLE : GROUPED.format(value);
}

/** A share between 0 and 1. */
export function formatPercent(share: number | null): string {
  if (share === null) return NOT_AVAILABLE;
  if (share === 0) return "0%";
  const percent = share * 100;
  if (percent < 0.1) return "<0.1%";
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** "2026-10-07" to "7 Oct 2026". Pure string handling, so the server time zone cannot shift the day. */
export function formatUtcDay(day: string): string {
  const [year, month, date] = day.split("-");
  const name = MONTHS[Number(month) - 1];
  return name === undefined ? day : `${Number(date)} ${name} ${year}`;
}

/** "2026-10-07 23:59", always in UTC. */
export function formatUtcMinute(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** "2026-10-07" to "7 Oct", for crowded axis labels. */
export function formatUtcDayShort(day: string): string {
  const [, month, date] = day.split("-");
  const name = MONTHS[Number(month) - 1];
  return name === undefined ? day : `${Number(date)} ${name}`;
}
