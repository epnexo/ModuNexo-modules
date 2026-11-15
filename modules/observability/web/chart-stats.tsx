import { summarize, type SeriesPoint } from "../lib/chart.ts";
import { formatValue, type Unit } from "../lib/format.ts";

/** Average, peak, low and the change over the window under a chart's title, so a trend reads without hovering. */
export default function ChartStats({ unit, points }: { unit: Unit; points: SeriesPoint[] }) {
  const summary = summarize(points);
  if (summary === null) return null;
  const flat = Math.abs(summary.change) < 1e-9;
  return (
    <dl className="obs-chart-stats">
      <div><dt>Avg</dt><dd>{formatValue(unit, summary.avg)}</dd></div>
      <div><dt>Peak</dt><dd>{formatValue(unit, summary.peak)}</dd></div>
      <div><dt>Low</dt><dd>{formatValue(unit, summary.low)}</dd></div>
      <div><dt>Change</dt><dd data-direction={flat ? "flat" : summary.change > 0 ? "up" : "down"}>{flat ? "—" : `${summary.change > 0 ? "▲" : "▼"} ${formatValue(unit, Math.abs(summary.change))}`}</dd></div>
    </dl>
  );
}
