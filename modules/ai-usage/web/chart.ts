/** Pure helpers behind the charts: scales, day ranges and shares. No rendering, so they can be tested. */

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

/** Round a maximum up to 1, 2, 2.5, 5 or 10 times a power of ten, for a shared axis ceiling. */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(max));
  const mantissa = max / base;
  const step = NICE_STEPS.find((candidate) => candidate >= mantissa - 1e-9) ?? 10;
  return step * base;
}

export interface DayValue<T> {
  day: string;
  value: T;
}

const DAY_MS = 86_400_000;

function parseDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Every UTC day from `from` to `to` inclusive. Days without a row get null, meaning nothing was recorded. */
export function fillDays(rows: DayValue<number>[], from: string, to: string): DayValue<number | null>[] {
  const known = new Map(rows.map((row) => [row.day, row.value]));
  const days: DayValue<number | null>[] = [];
  for (let at = parseDay(from); at <= parseDay(to); at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    days.push({ day, value: known.get(day) ?? null });
  }
  return days;
}

/** Shares of the known parts of a whole. Unknown parts stay null; they are not counted as zero. */
export function stackShares(parts: (number | null)[]): (number | null)[] {
  const total = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return parts.map((part) => (part === null ? null : total > 0 ? part / total : 0));
}

const MIN_FRACTION = 0.005;

const round = (n: number): number => Math.round(n * 100) / 100;

export interface Axis {
  /** The axis ceiling, a round value at or above the data maximum. */
  max: number;
  /** Tick values from 0 to `max`, at round steps. */
  ticks: number[];
}

/** Y-axis ceiling and tick values at round numbers (1, 2, 2.5 or 5 times a power of ten), at most five intervals. */
export function axisTicks(max: number): Axis {
  const ceiling = niceCeiling(max);
  const exponent = Math.floor(Math.log10(ceiling));
  let step = ceiling;
  search: for (let e = Math.max(exponent - 2, 0); e <= exponent; e += 1) {
    for (const mantissa of [1, 2, 2.5, 5]) {
      const candidate = mantissa * 10 ** e;
      const intervals = ceiling / candidate;
      if (intervals <= 5 && Math.abs(intervals - Math.round(intervals)) < 1e-9) {
        step = candidate;
        break search;
      }
    }
  }
  const ticks: number[] = [];
  for (let value = 0; value < ceiling - 1e-9; value += step) ticks.push(value);
  ticks.push(ceiling);
  return { max: ceiling, ticks };
}

/** Indices of the x labels to print so neighbors never collide: first label always, then every nth slot. */
export function thinLabels(count: number, slot: number, labelWidth: number, minGap: number): number[] {
  if (count <= 0) return [];
  const every = Math.max(1, Math.ceil((labelWidth + minGap) / Math.max(slot, 1e-9)));
  const shown: number[] = [];
  for (let index = 0; index < count; index += every) shown.push(index);
  return shown;
}

/** Running total. A day with no recorded usage (null) adds nothing but still gets a point. */
export function cumulative(values: (number | null)[]): number[] {
  let total = 0;
  return values.map((value) => (total += value ?? 0));
}

export interface StackSegment {
  /** Position of the part in the day's input array, so the caller can map it back to a tool. */
  index: number;
  value: number;
  y: number;
  height: number;
}

export interface StackBar {
  x: number;
  width: number;
  segments: StackSegment[];
}

/**
 * One bar per day. Parts stack from the baseline in input order; a null or zero part gets no segment.
 * Every segment above the first loses `gap` units at its bottom edge, so a gap of surface color separates touching segments.
 * Bars are centered in their slot and never wider than `maxBar`.
 */
export function stackLayout(days: (number | null)[][], box: { width: number; height: number; max: number; gap: number; maxBar: number }): StackBar[] {
  const slot = box.width / Math.max(days.length, 1);
  const width = Math.min(box.maxBar, Math.max(slot * 0.7, 1));
  return days.map((parts, day) => {
    const segments: StackSegment[] = [];
    let filled = 0;
    parts.forEach((value, index) => {
      if (value === null || value <= 0 || !(box.max > 0)) return;
      const top = Math.min(filled + (value / box.max) * box.height, box.height);
      const bottom = filled > 0 ? filled + box.gap : filled;
      const height = Math.max(top - bottom, 1);
      segments.push({ index, value, y: box.height - top, height });
      filled += (value / box.max) * box.height;
    });
    return { x: day * slot + (slot - width) / 2, width, segments };
  });
}

export interface Point {
  x: number;
  y: number;
}

/** One point per value, centered in the same slots the bars use, on a shared baseline at the bottom of the box. */
export function linePoints(values: number[], box: { width: number; height: number; max: number }): Point[] {
  const slot = box.width / Math.max(values.length, 1);
  return values.map((value, index) => ({
    x: index * slot + slot / 2,
    y: box.height - (box.max > 0 ? Math.min(value / box.max, 1) : 0) * box.height,
  }));
}

export function linePath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`).join("");
}

/** The line closed down to the baseline, for the light area fill. */
export function areaPath(points: Point[], baseline: number): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return "";
  return `${linePath(points)}L${round(last.x)} ${round(baseline)}L${round(first.x)} ${round(baseline)}Z`;
}

/** The data position nearest to a pointer x, clamped to the plot. */
export function nearestIndex(x: number, count: number, left: number, width: number): number {
  if (count <= 0) return -1;
  const slot = width / count;
  return Math.min(count - 1, Math.max(0, Math.floor((x - left) / slot)));
}

/** Bar lengths as fractions of the longest bar. Unknown values stay null; a known non-zero value keeps a visible sliver. */
export function barFractions(values: (number | null)[]): (number | null)[] {
  const largest = values.reduce<number>((max, value) => Math.max(max, value ?? 0), 0);
  return values.map((value) => {
    if (value === null) return null;
    if (value <= 0 || !(largest > 0)) return 0;
    return Math.max(value / largest, MIN_FRACTION);
  });
}

export interface RankedItem {
  label: string;
  amount: number;
}

/** The first `limit` items, with the rest folded into one "other" item. Nothing is folded when everything fits. */
export function topWithOther(items: RankedItem[], limit: number, otherLabel: (count: number) => string): (RankedItem & { other: boolean })[] {
  if (items.length <= limit) return items.map((item) => ({ ...item, other: false }));
  const tail = items.slice(limit);
  return [
    ...items.slice(0, limit).map((item) => ({ ...item, other: false })),
    { label: otherLabel(tail.length), amount: tail.reduce((sum, item) => sum + item.amount, 0), other: true },
  ];
}

export interface Readout {
  title: string;
  total: number;
  rows: { name: string; value: number | null; text: string }[];
}

/** What the tooltip of one day says: the day, then every tool's value (or "no usage"), then the day total. */
export function dayReadout(
  day: string,
  parts: { name: string; value: number | null }[],
  fmt: { day: (day: string) => string; value: (value: number) => string },
): Readout {
  return {
    title: fmt.day(day),
    total: parts.reduce((sum, part) => sum + (part.value ?? 0), 0),
    rows: parts.map((part) => ({ name: part.name, value: part.value, text: part.value === null ? "no usage" : fmt.value(part.value) })),
  };
}

/** "at" is a day chosen by index: the pointer position, or the day a focused chart starts on. */
export type DayAction = { type: "at"; index: number } | { type: "leave" } | { type: "escape" } | { type: "step"; by: 1 | -1 } | { type: "first" } | { type: "last" };

/** What the chart does with a key press, and whether it takes the key from the browser (arrows and Home/End would otherwise scroll). */
export function keyAction(key: string): { action: DayAction; preventDefault: boolean } | null {
  switch (key) {
    case "ArrowRight": return { action: { type: "step", by: 1 }, preventDefault: true };
    case "ArrowLeft": return { action: { type: "step", by: -1 }, preventDefault: true };
    case "Home": return { action: { type: "first" }, preventDefault: true };
    case "End": return { action: { type: "last" }, preventDefault: true };
    case "Escape": return { action: { type: "escape" }, preventDefault: false };
    default: return null;
  }
}

/** The active day after an action: an index inside 0..count-1, or null for none. With no days it is always null. */
export function nextActive(current: number | null, count: number, action: DayAction): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (action.type) {
    case "at": return Number.isInteger(action.index) && action.index >= 0 && action.index <= last ? action.index : null;
    case "leave":
    case "escape": return null;
    case "first": return 0;
    case "last": return last;
    case "step": {
      if (current === null) return action.by > 0 ? 0 : last;
      return Math.min(last, Math.max(0, Math.min(current, last) + action.by));
    }
  }
}

/** The drawing area inside a measured box. Never negative, even when the box is smaller than its margins. */
export function plotBox(width: number, height: number, margin: { left: number; top: number; right: number; bottom: number }): { width: number; height: number } {
  return { width: Math.max(width - margin.left - margin.right, 0), height: Math.max(height - margin.top - margin.bottom, 0) };
}
