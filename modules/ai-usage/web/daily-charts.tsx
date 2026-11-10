/// <reference lib="dom" />
"use client";

import Link from "next/link";
import { useState } from "react";
import { type ChartTool, StackedBars } from "./chart-client.tsx";
import { bucketDaily, bucketSeries, bucketTitle, GRAINS, GRAIN_LABELS, type Grain } from "./buckets.ts";
import { formatCompact } from "./format.ts";
import type { DailyRow } from "./queries.ts";

/**
 * The "Tokens per day/week/month" card. The server sends the daily rows once; changing the interval only regroups
 * them here, so the page is not requested again, the bars animate to the new shape and the address is kept in
 * sync for sharing and reloading. Without scripts the buttons are still plain links to the same address.
 */
export function DailyChartsView({
  daily,
  tools,
  from,
  to,
  initialGrain,
  hrefs,
}: {
  daily: DailyRow[];
  tools: ChartTool[];
  /** First and last UTC day shown, inclusive. */
  from: string;
  to: string;
  initialGrain: Grain;
  /** The page address for each interval, keeping the other filters. */
  hrefs: Record<Grain, string>;
}) {
  const [grain, setGrain] = useState<Grain>(initialGrain);

  const bucketed = bucketDaily(daily, grain);
  const sums = new Map(bucketed.map((row) => [`${row.day}|${row.tool}`, row.totalTokens]));
  const series = bucketSeries(from, to, grain);
  const perTool = tools.map((tool) => series.map((day) => ({ day, value: sums.get(`${day}|${tool.slug}`) ?? null })));
  const days = series.map((day, i) => ({ day, parts: perTool.map((values) => values[i]!.value) }));
  const totals = perTool.map((values) => values.reduce((sum, d) => sum + (d.value ?? 0), 0));
  const activeDays = [...new Set(bucketed.map((row) => row.day))].sort().reverse();
  const unit = grain;

  const choose = (event: React.MouseEvent<HTMLAnchorElement>, option: Grain) => {
    // Let the browser handle modified clicks (new tab, new window) as a normal link.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setGrain(option);
    try {
      window.history.replaceState(window.history.state, "", hrefs[option]);
    } catch {
      // The address stays as it was; the chart already changed.
    }
  };

  return (
    <section className="portlet au-chart" aria-label={`Tokens per ${unit}`}>
      <header className="portlet-head">
        <h2>Tokens per {unit}</h2>
      </header>
      <div className="portlet-body">
        <p className="portlet-note">
          {`Days are UTC${grain === "week" ? ", weeks start on Monday" : ""}. Gaps are ${unit}s with no recorded usage${grain === "day" ? "" : "; the first and last bar can cover only part of a " + unit}. Hover a bar, or use the arrow keys, to read it.`}
        </p>
        <nav className="au-seg au-grain" aria-label="Chart interval">
          {GRAINS.map((option) => (
            <Link key={option} href={hrefs[option]} scroll={false} aria-current={grain === option} onClick={(event) => choose(event, option)}>
              {GRAIN_LABELS[option]}
            </Link>
          ))}
        </nav>
        <ul className="au-legend" aria-label="Tools">
          {tools.map((tool, i) => (
            <li key={tool.slug} className={tool.className}>
              <span className="au-key" aria-hidden="true" />
              {tool.name}
              <span className="muted num">{formatCompact(totals[i] ?? 0)}</span>
            </li>
          ))}
        </ul>
        <StackedBars days={days} tools={tools} grain={grain} />

        <details>
          <summary>Show as table</summary>
          <div className="au-scroll table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{grain === "day" ? "Day (UTC)" : grain === "week" ? "Week starting (UTC)" : "Month (UTC)"}</th>
                  {tools.map((tool) => (
                    <th key={tool.slug} className="right">
                      {tool.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeDays.map((day) => (
                  <tr key={day}>
                    <td className="num">{grain === "month" ? bucketTitle(day, grain) : day}</td>
                    {tools.map((tool) => {
                      const amount = sums.get(`${day}|${tool.slug}`);
                      return (
                        <td key={tool.slug} className="right num">
                          {amount === undefined ? <span className="au-na">-</span> : formatCompact(amount)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}
