"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { axisTicks, nearestIndex, niceCeiling, plot, timeTicks, type SeriesPoint } from "../lib/chart.ts";
import { axisTime, formatValue, type Unit } from "../lib/format.ts";

/**
 * One metric over a time window: the average as a line, the min-max spread as a soft band, round ticks on both axes,
 * and a readout for the point under the pointer or reached with the arrow keys. The server sends plain data; the SVG
 * keeps a fixed viewBox and scales with its box, so nothing needs measuring.
 */

const W = 640;
const H = 210;
const MARGIN = { left: 46, top: 10, right: 12, bottom: 24 };
const PLOT = { width: W - MARGIN.left - MARGIN.right, height: H - MARGIN.top - MARGIN.bottom };

export interface TrendChartProps {
  label: string;
  unit: Unit;
  points: SeriesPoint[];
  /** The window shown, in epoch milliseconds. */
  from: number;
  to: number;
  /** A silence longer than this breaks the line. */
  gapMs: number;
  /** Fixed top of the axis (100 for a percentage); the data decides when left out. */
  max?: number;
}

export default function TrendChart({ label, unit, points, from, to, gapMs, max }: TrendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) {
    return <p className="empty">No data for {label.toLowerCase()} in this window.</p>;
  }
  const top = max ?? niceCeiling(Math.max(...points.map((point) => point.max)) * 1.05);
  const axis = max === undefined ? axisTicks(top) : { max, ticks: axisTicks(max).ticks };
  const drawn = plot(points, { ...PLOT, from, to, max: axis.max, gapMs });
  const xs = drawn.dots.map((dot) => MARGIN.left + dot.x);
  const at = active === null ? undefined : drawn.dots[active];
  const last = points.at(-1)!;
  const yOf = (value: number): number => MARGIN.top + PLOT.height - (Math.min(value, axis.max) / axis.max) * PLOT.height;
  const span = to - from;

  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(xs, ((event.clientX - box.left) / box.width) * W));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = (by: number) => setActive((current) => Math.min(points.length - 1, Math.max(0, (current ?? (by > 0 ? -1 : points.length)) + by)));
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (event.key === "Home") { event.preventDefault(); setActive(0); }
    else if (event.key === "End") { event.preventDefault(); setActive(points.length - 1); }
    else if (event.key === "Escape") setActive(null);
  };

  return (
    <div className="obs-chart">
      <svg
        className="obs-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        tabIndex={0}
        aria-label={`${label}, latest ${formatValue(unit, last.avg)}. Use the arrow keys to read each point.`}
        onPointerMove={onPointer}
        onPointerLeave={() => setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {axis.ticks.map((tick) => (
          <g key={tick}>
            <line className="obs-grid-line" x1={MARGIN.left} x2={W - MARGIN.right} y1={yOf(tick)} y2={yOf(tick)} />
            <text className="obs-axis-text" x={MARGIN.left - 6} y={yOf(tick) + 4} textAnchor="end">{formatValue(unit, tick)}</text>
          </g>
        ))}
        {timeTicks(from, to, 4).map((tick, index, all) => (
          <text key={tick} className="obs-axis-text" x={MARGIN.left + ((tick - from) / Math.max(span, 1)) * PLOT.width} y={H - 6} textAnchor={index === 0 ? "start" : index === all.length - 1 ? "end" : "middle"}>{axisTime(tick, span)}</text>
        ))}
        <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
          {drawn.area === "" ? null : <path className="obs-area" d={drawn.area} />}
          {drawn.band === "" ? null : <path className="obs-band" d={drawn.band} />}
          <path className="obs-line" d={drawn.line} pathLength={1} />
          {drawn.dots.length <= 1 ? drawn.dots.map((dot) => <circle key={dot.point.t} className="obs-dot" cx={dot.x} cy={dot.y} r={4} />) : null}
          {drawn.dots.length > 1 ? <circle className="obs-dot obs-dot-now" cx={drawn.dots.at(-1)!.x} cy={drawn.dots.at(-1)!.y} r={4} /> : null}
        </g>
        {at === undefined ? null : (
          <g>
            <line className="obs-cursor" x1={MARGIN.left + at.x} x2={MARGIN.left + at.x} y1={MARGIN.top} y2={MARGIN.top + PLOT.height} />
            <circle className="obs-dot" cx={MARGIN.left + at.x} cy={MARGIN.top + at.y} r={4} />
          </g>
        )}
      </svg>
      {at === undefined ? null : (
        <div className="obs-tip" role="status" style={{ left: `${((MARGIN.left + at.x) / W) * 100}%`, transform: at.x > PLOT.width / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
          <strong>{new Date(at.point.t).toISOString().slice(0, 16).replace("T", " ")} UTC</strong>
          <span>{label}: {formatValue(unit, at.point.avg)}</span>
          {at.point.max > at.point.min ? <span> (min {formatValue(unit, at.point.min)}, max {formatValue(unit, at.point.max)})</span> : null}
        </div>
      )}
    </div>
  );
}
