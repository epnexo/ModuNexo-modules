/// <reference lib="dom" />
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { areaPath, axisTicks, cumulative, dayReadout, keyAction, linePath, linePoints, nearestIndex, nextActive, plotBox, stackLayout, thinLabels, type DayAction } from "./chart.ts";
import { bucketAxisLabel, bucketTitle, type Grain } from "./buckets.ts";
import { formatCompact, formatUtcDay, formatUtcDayShort } from "./format.ts";

/**
 * The two interactive charts. They are the only client code of the page: the server sends plain data, and these
 * components lay it out with the pure helpers of chart.ts, draw inline SVG at the real pixel size of their box,
 * and add the hover and keyboard readout. Every value they show is also in the legend, the notes and the table.
 */

export interface ChartTool {
  slug: string;
  name: string;
  className: string;
}

/** Room for the y labels, the top edge, the right edge and the x labels, in px. */
const MARGIN = { left: 52, top: 10, right: 20, bottom: 28 };
const X_LABEL_WIDTH = 46;
const X_LABEL_GAP = 10;

interface Metrics {
  width: number;
  height: number;
  gap: number;
  radius: number;
  maxBar: number;
  lineWidth: number;
  dot: number;
}

/** What the server renders before the box is measured. The values mirror the chart tokens of theme.css, which win once measured. */
const FALLBACK: Metrics = { width: 1000, height: 320, gap: 2, radius: 4, maxBar: 24, lineWidth: 2, dot: 4 };

function token(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const parsed = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Measures the plot box and reads the chart tokens, so sizes live in theme.css and nowhere in code. */
function useMetrics(): [RefObject<HTMLDivElement | null>, Metrics] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(FALLBACK);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const style = getComputedStyle(el);
      setMetrics({
        width: Math.max(el.clientWidth, 1),
        height: Math.max(el.clientHeight, 1),
        gap: token(style, "--chart-bar-gap", FALLBACK.gap),
        radius: token(style, "--chart-bar-radius", FALLBACK.radius),
        maxBar: token(style, "--chart-bar-max", FALLBACK.maxBar),
        lineWidth: token(style, "--chart-line-width", FALLBACK.lineWidth),
        dot: token(style, "--chart-dot-radius", FALLBACK.dot),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, metrics];
}

interface TipRow {
  key: ReactNode;
  name: string;
  text: string;
}

function Tooltip({ x, flip, title, rows, foot }: { x: number; flip: boolean; title: string; rows: TipRow[]; foot?: TipRow }) {
  return (
    <div className="au-tip" role="status" style={{ left: x, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}>
      <div className="au-tip-title">{title}</div>
      {rows.map((row) => (
        <div key={row.name} className="au-tip-row">
          {row.key}
          <strong className="num">{row.text}</strong>
          <span>{row.name}</span>
        </div>
      ))}
      {foot === undefined ? null : (
        <div className="au-tip-row au-tip-foot">
          <strong className="num">{foot.text}</strong>
          <span>{foot.name}</span>
        </div>
      )}
    </div>
  );
}

function YAxis({ ticks, max, plotWidth, plotHeight }: { ticks: number[]; max: number; plotWidth: number; plotHeight: number }) {
  return (
    <>
      {ticks.map((tick) => {
        const y = plotHeight - (tick / max) * plotHeight;
        return (
          <g key={tick}>
            <line className={tick === 0 ? "au-axis" : "au-grid"} x1={0} x2={plotWidth} y1={y} y2={y} />
            <text className="au-tick" x={-8} y={y} textAnchor="end" dominantBaseline="middle">
              {formatCompact(tick)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function XAxis({ days, plotWidth, plotHeight, grain = "day" }: { days: string[]; plotWidth: number; plotHeight: number; grain?: Grain }) {
  const slot = plotWidth / Math.max(days.length, 1);
  return (
    <>
      {thinLabels(days.length, slot, X_LABEL_WIDTH, X_LABEL_GAP).map((index) => (
        <text key={days[index]} className="au-tick" x={index * slot + slot / 2} y={plotHeight + 18} textAnchor="middle">
          {bucketAxisLabel(days[index]!, grain, formatUtcDayShort)}
        </text>
      ))}
    </>
  );
}

/** Pointer and arrow-key control of the active day, shared by both charts. The rules live in nextActive and keyAction; this only translates events. */
function useActiveDay(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const apply = (action: DayAction) => setActive((current) => nextActive(current, count, action));
  const move = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    apply({ type: "at", index: nearestIndex(event.clientX - box.left, count, 0, box.width) });
  };
  const leave = () => apply({ type: "leave" });
  /** Focus starts the readout on `start` (the busiest or the last day) unless a day is already active. */
  const focus = (start: number) => setActive((current) => current ?? nextActive(null, count, { type: "at", index: start }));
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    const handled = keyAction(event.key);
    if (handled === null) return;
    if (handled.preventDefault) event.preventDefault();
    apply(handled.action);
  };
  return { active, focus, move, leave, key };
}

export function StackedBars({ days, tools, grain = "day" }: { days: { day: string; parts: (number | null)[] }[]; tools: ChartTool[]; grain?: Grain }) {
  const unit = grain;
  const [ref, m] = useMetrics();
  const uid = useId().replace(/:/g, "");
  const plot = plotBox(m.width, m.height, MARGIN);
  const totals = days.map((d) => d.parts.reduce<number>((sum, part) => sum + (part ?? 0), 0));
  const axis = axisTicks(Math.max(...totals, 0));
  const bars = stackLayout(days.map((d) => d.parts), { ...plot, max: axis.max, gap: m.gap, maxBar: m.maxBar });
  const slot = plot.width / Math.max(days.length, 1);
  const { active, focus, move, leave, key } = useActiveDay(days.length);
  const activeDay = active === null ? null : days[active];
  const peak = totals.indexOf(Math.max(...totals, 0));

  return (
    <div ref={ref} className="au-plot au-plot-bars">
      <svg
        className="au-svg"
        viewBox={`0 0 ${m.width} ${m.height}`}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`Tokens per ${unit} stacked by tool, ${days.length} ${unit}s, busiest ${unit} ${days[peak] === undefined ? "none" : bucketTitle(days[peak].day, grain)} with ${formatCompact(totals[peak] ?? 0)}. Use the left and right arrow keys to read each ${unit}. Every value is in the table below.`}
        onKeyDown={key}
        onBlur={leave}
        onFocus={() => focus(peak)}
      >
        <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
          {active === null ? null : <rect className="au-wash" x={active * slot} y={0} width={slot} height={plot.height} />}
          <YAxis ticks={axis.ticks} max={axis.max} plotWidth={plot.width} plotHeight={plot.height} />
          {bars.map((bar, i) => {
            const first = bar.segments[0];
            const top = Math.min(...bar.segments.map((s) => s.y));
            if (first === undefined) return null;
            return (
              <g key={days[i]!.day} clipPath={`url(#${uid}-${i})`}>
                <clipPath id={`${uid}-${i}`}>
                  <rect x={bar.x} y={top} width={bar.width} height={plot.height - top + m.radius * 2} rx={m.radius} />
                </clipPath>
                {bar.segments.map((segment) => (
                  <rect key={segment.index} className={`au-bar ${tools[segment.index]?.className ?? "au-t0"}`} x={bar.x} y={segment.y} width={bar.width} height={segment.height} />
                ))}
              </g>
            );
          })}
          <XAxis days={days.map((d) => d.day)} plotWidth={plot.width} plotHeight={plot.height} grain={grain} />
          <rect className="au-hit" x={0} y={0} width={plot.width} height={plot.height} onPointerMove={move} onPointerLeave={leave} />
        </g>
      </svg>
      {active === null || activeDay === null || activeDay === undefined ? null : (
        <StackTip day={activeDay} tools={tools} grain={grain} x={MARGIN.left + active * slot + slot / 2} flip={active > days.length / 2} />
      )}
    </div>
  );
}

function StackTip({ day, tools, x, flip, grain }: { day: { day: string; parts: (number | null)[] }; tools: ChartTool[]; x: number; flip: boolean; grain: Grain }) {
  const readout = dayReadout(
    day.day,
    tools.map((tool, i) => ({ name: tool.name, value: day.parts[i] ?? null })),
    { day: (d) => `${bucketTitle(d, grain)} (UTC)`, value: (v) => formatCompact(v) },
  );
  const empty = readout.rows.every((row) => row.value === null);
  return (
    <Tooltip
      x={x}
      flip={flip}
      title={readout.title}
      rows={empty ? [] : readout.rows.map((row, i) => ({ ...row, key: <span className={`au-key ${tools[i]?.className ?? "au-t0"}`} aria-hidden="true" /> })).reverse()}
      foot={{ key: null, name: empty ? "no usage recorded" : `${grain} total`, text: empty ? "-" : formatCompact(readout.total) }}
    />
  );
}

export function CumulativeLine({ days }: { days: { day: string; value: number | null }[] }) {
  const [ref, m] = useMetrics();
  const plot = plotBox(m.width, m.height, MARGIN);
  const running = cumulative(days.map((d) => d.value));
  const axis = axisTicks(running.at(-1) ?? 0);
  const points = linePoints(running, { ...plot, max: axis.max });
  const { active, focus, move, leave, key } = useActiveDay(days.length);
  const at = active === null ? undefined : points[active];
  const end = points.at(-1);

  return (
    <div ref={ref} className="au-plot au-plot-line">
      <svg
        className="au-svg"
        viewBox={`0 0 ${m.width} ${m.height}`}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`Cumulative tokens over ${days.length} days, ending at ${formatCompact(running.at(-1) ?? 0)}. Use the left and right arrow keys to read each day.`}
        onKeyDown={key}
        onBlur={leave}
        onFocus={() => focus(days.length - 1)}
      >
        <g transform={`translate(${MARGIN.left} ${MARGIN.top})`}>
          <YAxis ticks={axis.ticks} max={axis.max} plotWidth={plot.width} plotHeight={plot.height} />
          <path className="au-area" d={areaPath(points, plot.height)} />
          <path className="au-line" d={linePath(points)} strokeWidth={m.lineWidth} />
          {end === undefined ? null : <circle className="au-dot-end" cx={end.x} cy={end.y} r={m.dot} />}
          {at === undefined ? null : (
            <>
              <line className="au-cross" x1={at.x} x2={at.x} y1={0} y2={plot.height} />
              <circle className="au-dot-end" cx={at.x} cy={at.y} r={m.dot} />
            </>
          )}
          <XAxis days={days.map((d) => d.day)} plotWidth={plot.width} plotHeight={plot.height} />
          <rect className="au-hit" x={0} y={0} width={plot.width} height={plot.height} onPointerMove={move} onPointerLeave={leave} />
        </g>
      </svg>
      {active === null || at === undefined ? null : (
        <Tooltip
          x={MARGIN.left + at.x}
          flip={active > days.length / 2}
          title={`${formatUtcDay(days[active]!.day)} (UTC)`}
          rows={[
            { key: <span className="au-key au-total" aria-hidden="true" />, name: "total to date", text: formatCompact(running[active]!) },
            { key: null, name: "that day", text: days[active]!.value === null ? "no usage" : formatCompact(days[active]!.value) },
          ]}
        />
      )}
    </div>
  );
}
