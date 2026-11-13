/** Pure helpers behind the host charts: axes and the line and band paths. No rendering, so they can be tested. */

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;
const round = (n: number): number => Math.round(n * 100) / 100;

/** Round a maximum up to 1, 2, 2.5, 5 or 10 times a power of ten, for the top of an axis. */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(max));
  const mantissa = max / base;
  return (NICE_STEPS.find((candidate) => candidate >= mantissa - 1e-9) ?? 10) * base;
}

/** Y-axis ceiling and tick values at round steps, at most five intervals, starting at 0. */
export function axisTicks(max: number): { max: number; ticks: number[] } {
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
  for (let value = 0; value < ceiling - 1e-9; value += step) ticks.push(round(value));
  ticks.push(ceiling);
  return { max: ceiling, ticks };
}

/** `count` equal intervals between two instants: count + 1 ticks, the first and last included. */
export function timeTicks(from: number, to: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => from + ((to - from) * index) / count);
}

export interface SeriesPoint {
  /** Start of the bucket, in epoch milliseconds. */
  t: number;
  avg: number;
  min: number;
  max: number;
}

export interface PlotBox {
  width: number;
  height: number;
  /** The time window shown, in epoch milliseconds. */
  from: number;
  to: number;
  /** The value at the top of the plot; anything above it is drawn on the top edge. */
  max: number;
  /** A silence longer than this breaks the line instead of joining the points across it. */
  gapMs: number;
}

export interface Plotted {
  /** The average line, as an SVG path. A run of one point has no line; the dot shows it. */
  line: string;
  /** The min-max band of every run of two or more points, empty when nothing in it spreads. */
  band: string;
  dots: { x: number; y: number; point: SeriesPoint }[];
}

export function plot(points: SeriesPoint[], box: PlotBox): Plotted {
  const span = Math.max(box.to - box.from, 1);
  const x = (t: number): number => round(((t - box.from) / span) * box.width);
  const y = (value: number): number => round(box.height - Math.max(0, Math.min(value / (box.max > 0 ? box.max : 1), 1)) * box.height);
  const runs: SeriesPoint[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run !== undefined && previous !== undefined && point.t - previous.t <= box.gapMs) run.push(point);
    else runs.push([point]);
  }
  const line = runs.map((run) => run.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t)} ${y(point.avg)}`).join("")).join("");
  const band = runs
    .filter((run) => run.length >= 2 && run.some((point) => point.max > point.min))
    .map((run) => `${run.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t)} ${y(point.max)}`).join("")}${[...run].reverse().map((point) => `L${x(point.t)} ${y(point.min)}`).join("")}Z`)
    .join("");
  return { line, band, dots: points.map((point) => ({ x: x(point.t), y: y(point.avg), point })) };
}

/** The index of the position closest to a pointer x, or -1 when there are none. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1;
  xs.forEach((candidate, index) => {
    if (best === -1 || Math.abs(candidate - x) < Math.abs((xs[best] ?? 0) - x)) best = index;
  });
  return best;
}
