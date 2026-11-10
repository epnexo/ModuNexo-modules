/// <reference lib="dom" />
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { type ChartTool, StackedBars } from "./chart-client.tsx";
import { bucketDaily, bucketSeries, bucketTitle, GRAINS, GRAIN_LABELS, type Grain } from "./buckets.ts";
import { formatCompact } from "./format.ts";
import { CHART_DATA_PATH, PERIODS, PERIOD_LABELS, withFilters, type Filters, type Period } from "./filters.ts";
import type { DailyRow } from "./queries.ts";

/**
 * The "Tokens per day/week/month" card. The server sends the daily rows once; changing the interval only regroups
 * them here, and changing the period asks the chart-data route for that period's rows alone, so the rest of the page
 * is not requested again. Either way the bars animate to the new shape and the address is kept in sync for sharing
 * and reloading. Without scripts the buttons are still plain links to the same address.
 */
export function DailyChartsView({
  daily: initialDaily,
  tools,
  from: initialFrom,
  to,
  initialGrain,
  filters,
  path,
}: {
  daily: DailyRow[];
  tools: ChartTool[];
  /** First and last UTC day shown, inclusive. */
  from: string;
  to: string;
  initialGrain: Grain;
  /** The filters the page was drawn with; `period` and `tool` say which rows `daily` holds. */
  filters: Filters;
  /** The page's own address, which the chart keeps in step with what it shows. */
  path: string;
}) {
  const [grain, setGrain] = useState<Grain>(initialGrain);
  const [period, setPeriod] = useState<Period>(filters.period);
  const [rows, setRows] = useState({ daily: initialDaily, from: initialFrom });
  const [status, setStatus] = useState<"idle" | "loading" | "failed">("idle");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const { daily, from } = rows;
  const hrefFor = (next: { period?: Period; grain?: Grain }) => withFilters({ ...filters, period, grain }, next, path);

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
    syncAddress(hrefFor({ grain: option }));
  };

  const syncAddress = (href: string) => {
    try {
      window.history.replaceState(window.history.state, "", href);
    } catch {
      // The address stays as it was; the chart already changed.
    }
  };

  const choosePeriod = async (event: React.MouseEvent<HTMLAnchorElement>, option: Period) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (option === period && status !== "failed") return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setStatus("loading");
    try {
      const query = new URLSearchParams({ period: option });
      if (filters.tool !== null) query.set("tool", filters.tool);
      const response = await fetch(`${CHART_DATA_PATH}?${query}`, { signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { daily: DailyRow[]; from: string };
      if (!Array.isArray(body.daily) || typeof body.from !== "string") throw new Error("unexpected answer");
      setRows({ daily: body.daily, from: body.from });
      setPeriod(option);
      setStatus("idle");
      syncAddress(withFilters({ ...filters, period: option, grain }, {}, path));
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus("failed");
      void error;
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
        <div className="au-chart-controls">
          <nav className="seg au-grain" aria-label="Chart period">
            {PERIODS.map((option) => (
              <Link key={option} href={hrefFor({ period: option })} scroll={false} prefetch={false} aria-current={period === option} onClick={(event) => void choosePeriod(event, option)}>
                {PERIOD_LABELS[option]}
              </Link>
            ))}
          </nav>
          <nav className="seg au-grain" aria-label="Chart interval">
            {GRAINS.map((option) => (
              <Link key={option} href={hrefFor({ grain: option })} scroll={false} aria-current={grain === option} onClick={(event) => choose(event, option)}>
                {GRAIN_LABELS[option]}
              </Link>
            ))}
          </nav>
        </div>
        <p className="au-chart-status" role="status" aria-live="polite">
          {status === "loading" ? "Loading that period…" : status === "failed" ? "Could not load that period. Try again." : ""}
        </p>
        <ul className="au-legend" aria-label="Tools">
          {tools.map((tool, i) => (
            <li key={tool.slug} className={tool.className}>
              <span className="au-key" aria-hidden="true" />
              {tool.name}
              <span className="muted num">{formatCompact(totals[i] ?? 0)}</span>
            </li>
          ))}
        </ul>
        <div aria-busy={status === "loading"} data-loading={status === "loading"}>
          <StackedBars days={days} tools={tools} grain={grain} />
        </div>

        <details>
          <summary>Show as table</summary>
          <div className="au-scroll table-scroll">
            <table className="data-table au-strong-first">
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
