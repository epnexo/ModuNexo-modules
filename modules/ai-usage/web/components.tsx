import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { type ChartTool, CumulativeLine } from "./chart-client.tsx";
import { DailyChartsView } from "./daily-charts.tsx";
import { GRAINS, type Grain } from "./buckets.ts";
import { barFractions, cumulative, fillDays, stackShares, topWithOther } from "./chart.ts";
import { PERIODS, PERIOD_LABELS, type Filters, toolColorSlot, withFilters } from "./filters.ts";
import { NOT_AVAILABLE, formatCompact, formatCount, formatPercent, formatUtcMinute } from "./format.ts";
import type { GroupedModels } from "./group.ts";
import { cacheHitRate, formatUsd, heatLevel, type CostEstimate } from "./metrics.ts";
import type { DailyRow, HourRow, SessionRow, Summary, ToolInfo, ToolRow } from "./queries.ts";

/** Tools with their display name and fixed color class. */
export interface ToolStyle {
  slug: string;
  name: string;
  className: string;
}

export function toolStyles(tools: ToolInfo[]): Map<string, ToolStyle> {
  const slugs = tools.map((tool) => tool.slug);
  return new Map(tools.map((tool) => [tool.slug, { slug: tool.slug, name: tool.name, className: `au-t${toolColorSlot(tool.slug, slugs)}` }]));
}

/** A tool that is not in the tools table any more still renders, in the neutral color. */
export function styleOf(styles: Map<string, ToolStyle>, slug: string): ToolStyle {
  return styles.get(slug) ?? { slug, name: slug, className: "au-t0" };
}

/** The shell's portlet pattern: a header band holding the heading, a body holding the note and the content. */
export function Portlet({ label, title, note, className, children }: { label: string; title: string; note?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`portlet ${className ?? ""}`} aria-label={label}>
      <header className="portlet-head">
        <h2>{title}</h2>
      </header>
      <div className="portlet-body">
        {note === undefined ? null : <p className="portlet-note">{note}</p>}
        {children}
      </div>
    </section>
  );
}

function Na() {
  return (
    <span className="au-na" title="Not reported by the tool">
      {NOT_AVAILABLE}
    </span>
  );
}

export const value = (n: number | null, format: (n: number) => string = formatCompact): ReactNode => (n === null ? <Na /> : format(n));

export function ToolName({ style }: { style: ToolStyle }) {
  return (
    <span className={`au-cell-tool ${style.className}`}>
      <span className="au-dot" aria-hidden="true" />
      {style.name}
    </span>
  );
}

export function FilterBar({ filters, tools }: { filters: Filters; tools: ToolInfo[] }) {
  const styles = toolStyles(tools);
  return (
    <div className="au-filters">
      <nav className="au-seg" aria-label="Period">
        {PERIODS.map((period) => (
          <Link key={period} href={withFilters(filters, { period })} aria-current={filters.period === period}>
            {PERIOD_LABELS[period]}
          </Link>
        ))}
      </nav>
      <nav className="au-seg" aria-label="Tool">
        <Link href={withFilters(filters, { tool: null })} aria-current={filters.tool === null}>
          All tools
        </Link>
        {tools.map((tool) => (
          <Link key={tool.slug} href={withFilters(filters, { tool: tool.slug })} aria-current={filters.tool === tool.slug} className={styleOf(styles, tool.slug).className}>
            <span className="au-dot" aria-hidden="true" />
            {tool.name}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Notice({ title, children, tone = "warn" }: { title: string; children: ReactNode; tone?: "warn" | "error" }) {
  return (
    <div className={`notice ${tone === "error" ? "error" : ""}`} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function EmptyState({ periodLabel, toolName, sendCommand }: { periodLabel: string; toolName: string | null; sendCommand: string | null }) {
  return (
    <Portlet label="No usage recorded" title="No usage recorded" className="au-empty">
      <p>
        {toolName === null ? "No tool reported" : `${toolName} reported`} token usage for {periodLabel.toLowerCase()}. Try a longer period
        {toolName === null ? "" : " or another tool"}. To load usage from a computer, an administrator can find how to connect it under AI usage in Settings.
      </p>
      {sendCommand === null ? null : <pre className="au-code">{sendCommand}</pre>}
    </Portlet>
  );
}

/** The cost estimate and whether the administrator entered any price at all. */
export interface CostView {
  estimate: CostEstimate;
  hasPrices: boolean;
}

function costCard(cost: CostView): { label: string; value: string; sub: string; title?: string } {
  if (!cost.hasPrices) return { label: "Est. cost", value: "Not set", sub: "Enter model prices in Settings", title: "No model price has been entered, so no cost can be estimated" };
  const { cost: dollars, pricedTokens, unpricedTokens } = cost.estimate;
  const covered = pricedTokens + unpricedTokens > 0 ? pricedTokens / (pricedTokens + unpricedTokens) : 0;
  return {
    label: "Est. cost",
    value: formatUsd(dollars),
    sub: `${formatPercent(covered)} of tokens priced`,
    title: `What the priced tokens would cost at API prices. ${formatCompact(unpricedTokens)} tokens have no price and are left out.`,
  };
}

export function Headline({ summary, cost }: { summary: Summary; cost?: CostView }) {
  const hit = cacheHitRate(summary);
  const cards: { label: string; value: string; sub: string; title?: string }[] = [
    { label: "Total tokens", value: formatCompact(summary.totalTokens), sub: formatCount(summary.totalTokens), title: `${formatCount(summary.totalTokens)} tokens` },
    { label: "Sessions", value: formatCount(summary.sessions), sub: "with recorded usage" },
    { label: "Active days", value: formatCount(summary.activeDays), sub: "UTC days with usage" },
    { label: "Output tokens", value: formatCompact(summary.outputTokens), sub: `Fresh input ${formatCompact(summary.inputTokens)}` },
    { label: "Cache hit", value: hit === null ? NOT_AVAILABLE : formatPercent(hit), sub: "of input served from cache", title: "Cache reads over fresh input, cache reads and cache writes" },
    ...(cost === undefined ? [] : [costCard(cost)]),
  ];
  return (
    <dl className="kpis" aria-label="Headline numbers">
      {cards.map((card, i) => (
        <div key={card.label} className={`kpi kpi-${(i % 4) + 1}`}>
          <dt>{card.label}</dt>
          <dd className="kpi-value" title={card.title}>
            {card.value}
          </dd>
          <dd className="kpi-sub num">{card.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface HBarRow {
  key: string;
  label: string;
  amount: number | null;
  /** Share of the whole, 0 to 1; null when the part is not reported. */
  share: number | null;
  /** A fold of several items, drawn in the neutral color. */
  other?: boolean;
  /** The label is not a real name (a model the tool did not report). */
  quiet?: boolean;
  /** A short mark printed after the label, for example `est.` for a count that is inferred. */
  tag?: { text: string; title: string };
}

/** Horizontal bars as plain HTML so labels keep their real size on a phone. Length is relative to the largest bar; the value and share are printed. */
export function HBars({ rows, label }: { rows: HBarRow[]; label: string }) {
  const fractions = barFractions(rows.map((row) => row.amount));
  return (
    <ul className="au-hbars" aria-label={label}>
      {rows.map((row, i) => {
        const fraction = fractions[i] ?? null;
        return (
          <li key={row.key} className={`au-hbar ${row.other === true ? "au-hbar-other" : ""}`}>
            <span className={`au-hbar-label ${row.quiet === true ? "muted" : ""}`} title={row.label}>
              {row.label}
              {row.tag === undefined ? null : (
                <abbr className="au-tag" title={row.tag.title}>
                  {row.tag.text}
                </abbr>
              )}
            </span>
            <span className="au-hbar-track" aria-hidden="true">
              {fraction === null ? null : <span className="au-hbar-fill" style={{ width: `${fraction * 100}%` }} />}
            </span>
            <span className="au-hbar-value num">
              <strong>{row.amount === null ? <Na /> : formatCompact(row.amount)}</strong>
              <span className="muted">{row.amount === null ? "not reported" : formatPercent(row.share)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TokenSplit({ summary }: { summary: Summary }) {
  const parts: { key: string; label: string; amount: number | null }[] = [
    { key: "input", label: "Fresh input", amount: summary.inputTokens },
    { key: "read", label: "Cache read", amount: summary.cacheReadTokens },
    { key: "write", label: "Cache write", amount: summary.cacheWriteTokens },
    { key: "output", label: "Output", amount: summary.outputTokens },
  ];
  const shares = stackShares(parts.map((part) => part.amount));
  return (
    <Portlet label="Token split" title="Token split" className="au-split-portlet" note={`Shares of the total. A part a tool does not report is shown as ${NOT_AVAILABLE}, not as zero.`}>
      <HBars label="Tokens by type" rows={parts.map((part, i) => ({ ...part, share: shares[i] ?? null }))} />
    </Portlet>
  );
}

const MODEL_BARS = 6;

export function ModelShare({ grouped }: { grouped: GroupedModels }) {
  const total = grouped.models.reduce((sum, m) => sum + m.totalTokens, 0) + (grouped.other?.totalTokens ?? 0);
  const extra = grouped.other?.count ?? 0;
  const ranked = topWithOther(
    grouped.models.map((model) => ({ label: model.model ?? "Model not reported", amount: model.totalTokens })),
    MODEL_BARS,
    (count) => `${count + extra} other models`,
  );
  const rows: HBarRow[] = ranked.map((item, i) => {
    const folded = item.other && grouped.other !== null ? grouped.other.totalTokens : 0;
    const amount = item.amount + folded;
    return { key: `${i}-${item.label}`, label: item.label, amount, share: total > 0 ? amount / total : 0, other: item.other, quiet: item.label === "Model not reported" };
  });
  return (
    <Portlet
      label="Share by model"
      title="Share by model"
      className="au-model-portlet"
      note="Largest models by tokens; the rest are folded into one bar. The By model table lists every model."
    >
      <HBars label="Tokens by model" rows={rows} />
    </Portlet>
  );
}

export function DailyCharts({
  daily,
  tools,
  styles,
  from,
  to,
  grain,
  grainHref,
}: {
  daily: DailyRow[];
  tools: ToolInfo[];
  styles: Map<string, ToolStyle>;
  /** First and last UTC day shown, inclusive. */
  from: string;
  to: string;
  /** What one bar covers when the page loads. */
  grain: Grain;
  /** The page address that shows the chart at another interval, keeping the other filters. */
  grainHref: (grain: Grain) => string;
}) {
  const chartTools: ChartTool[] = tools.map((tool) => ({ slug: tool.slug, name: tool.name, className: styleOf(styles, tool.slug).className }));
  const hrefs = Object.fromEntries(GRAINS.map((option) => [option, grainHref(option)])) as Record<Grain, string>;
  return <DailyChartsView daily={daily} tools={chartTools} from={from} to={to} initialGrain={grain} hrefs={hrefs} />;
}

export function CumulativeTokens({ daily, from, to }: { daily: DailyRow[]; from: string; to: string }) {
  const perDay = new Map<string, number>();
  for (const row of daily) perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.totalTokens);
  const days = fillDays([...perDay].map(([day, value]) => ({ day, value })), from, to);
  const running = cumulative(days.map((d) => d.value));
  const rows = days.flatMap((d, i) => (d.value === null ? [] : [{ day: d.day, value: d.value, total: running[i]! }])).reverse();

  return (
    <Portlet
      label="Cumulative tokens"
      title="Cumulative tokens"
      className="au-cumulative"
      note={`Running total over ${days.length} UTC days, ending at ${formatCompact(running.at(-1) ?? 0)} (${formatCount(running.at(-1) ?? 0)}).`}
    >
      <CumulativeLine days={days} />
      <details>
        <summary>Show as table</summary>
        <div className="au-scroll table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
                <th className="right">That day</th>
                <th className="right">Total to date</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.day}>
                  <td className="num">{row.day}</td>
                  <td className="right num">{formatCompact(row.value)}</td>
                  <td className="right num">{formatCompact(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Portlet>
  );
}

export function Share({ amount, total, className }: { amount: number; total: number; className?: string }) {
  const share = total > 0 ? amount / total : 0;
  return (
    <div className={`au-share ${className ?? ""}`}>
      <span className="au-share-track" aria-hidden="true">
        <span className="au-share-fill" style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` } as CSSProperties} />
      </span>
      <span className="num">{formatPercent(share)}</span>
    </div>
  );
}

export function ByToolTable({ rows, styles, cost }: { rows: ToolRow[]; styles: Map<string, ToolStyle>; cost?: CostView }) {
  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return (
    <Portlet label="Usage by tool" title="By tool" note={`Tool-reported token counters. ${NOT_AVAILABLE} means the tool does not report that counter.`}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th className="right">Tokens</th>
              <th>Share</th>
              <th className="right">Cache hit</th>
              {cost?.hasPrices ? <th className="right">Est. cost</th> : null}
              <th className="right">Sessions</th>
              <th className="right">Active days</th>
              <th className="right">Fresh input</th>
              <th className="right">Cache read</th>
              <th className="right">Cache write</th>
              <th className="right">Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const style = styleOf(styles, row.tool);
              return (
                <tr key={row.tool} className={style.className}>
                  <td>
                    <ToolName style={style} />
                  </td>
                  <td className="right num">{formatCompact(row.totalTokens)}</td>
                  <td>
                    <Share amount={row.totalTokens} total={total} />
                  </td>
                  <td className="right num">{value(cacheHitRate(row), formatPercent)}</td>
                  {cost?.hasPrices ? <td className="right num">{cost.estimate.byTool.has(row.tool) ? formatUsd(cost.estimate.byTool.get(row.tool)!) : <Na />}</td> : null}
                  <td className="right num">{formatCount(row.sessions)}</td>
                  <td className="right num">{formatCount(row.activeDays)}</td>
                  <td className="right num">{value(row.inputTokens)}</td>
                  <td className="right num">{value(row.cacheReadTokens)}</td>
                  <td className="right num">{value(row.cacheWriteTokens)}</td>
                  <td className="right num">{value(row.outputTokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Portlet>
  );
}

export function ByModelTable({ grouped, styles }: { grouped: GroupedModels; styles: Map<string, ToolStyle> }) {
  const total = grouped.models.reduce((sum, m) => sum + m.totalTokens, 0) + (grouped.other?.totalTokens ?? 0);
  return (
    <Portlet label="Usage by model" title="By model" note="A model used through more than one tool is listed once, with each tool named.">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Tools</th>
              <th className="right">Tokens</th>
              <th>Share</th>
              <th className="right">Sessions</th>
            </tr>
          </thead>
          <tbody>
            {grouped.models.map((model) => (
              <tr key={model.model ?? "(none)"}>
                <td>{model.model ?? <span className="au-na">Model not reported</span>}</td>
                <td>
                  <span className="au-tools-list">
                    {model.tools.map((entry) => (
                      <ToolName key={entry.tool} style={styleOf(styles, entry.tool)} />
                    ))}
                  </span>
                </td>
                <td className="right num">{formatCompact(model.totalTokens)}</td>
                <td>
                  <Share amount={model.totalTokens} total={total} className="au-t0" />
                </td>
                <td className="right num">{formatCount(model.sessions)}</td>
              </tr>
            ))}
            {grouped.other === null ? null : (
              <tr>
                <td className="muted">{grouped.other.count} other models</td>
                <td />
                <td className="right num">{formatCompact(grouped.other.totalTokens)}</td>
                <td>
                  <Share amount={grouped.other.totalTokens} total={total} className="au-t0" />
                </td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Portlet>
  );
}

export function RecentSessions({ rows, styles }: { rows: SessionRow[]; styles: Map<string, ToolStyle> }) {
  return (
    <Portlet label="Recent sessions" title="Recent sessions" note="Newest sessions that started in this period. Times are UTC.">
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          No sessions started in this period.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Project</th>
                <th>Started (UTC)</th>
                <th>Model</th>
                <th className="right">Tokens</th>
                <th className="right">Prompts</th>
                <th className="right">Tool calls</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const hasUsage = row.events > 0;
                return (
                  <tr key={row.id}>
                    <td>
                      <ToolName style={styleOf(styles, row.tool)} />
                    </td>
                    <td>{row.projectLabel ?? <Na />}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                      {formatUtcMinute(row.startedAt)}
                    </td>
                    <td>{!hasUsage ? <Na /> : row.model ?? <span className="muted">multiple</span>}</td>
                    <td className="right num">{hasUsage ? formatCompact(row.totalTokens) : <Na />}</td>
                    <td className="right num">{formatCount(row.messageCount)}</td>
                    <td className="right num">{formatCount(row.toolCallCount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="au-note">Prompt and tool-call counts come from each tool&apos;s own logs; a 0 can mean the tool does not log them.</p>
    </Portlet>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** When the tools are used: tokens by UTC weekday and hour as a heat grid. Each cell names its slot and amount. */
export function UsageHours({ rows }: { rows: HourRow[] }) {
  const cell = new Map(rows.map((row) => [`${row.weekday}:${row.hour}`, row.totalTokens]));
  const max = rows.reduce((top, row) => Math.max(top, row.totalTokens), 0);
  const busiest = rows.reduce<HourRow | null>((top, row) => (top === null || row.totalTokens > top.totalTokens ? row : top), null);
  return (
    <Portlet
      label="Usage by weekday and hour"
      title="When it is used"
      note={busiest === null ? "No usage in this period." : `Tokens by UTC weekday and hour. Busiest: ${WEEKDAYS[busiest.weekday]} ${String(busiest.hour).padStart(2, "0")}:00, ${formatCompact(busiest.totalTokens)} tokens.`}
    >
      <div className="au-heat" role="img" aria-label={busiest === null ? "No usage" : `Heat grid of tokens by weekday and hour; busiest ${WEEKDAYS[busiest.weekday]} ${busiest.hour}:00 UTC`}>
        <span />
        {HOURS.map((hour) => (
          <span key={hour} className="au-heat-hour" aria-hidden="true">
            {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
          </span>
        ))}
        {WEEKDAYS.map((day, weekday) => (
          <div key={day} className="au-heat-row">
            <span className="au-heat-day" aria-hidden="true">
              {day}
            </span>
            {HOURS.map((hour) => {
              const tokens = cell.get(`${weekday}:${hour}`) ?? 0;
              return <span key={hour} className={`au-heat-cell au-heat-${heatLevel(tokens, max)}`} title={`${day} ${String(hour).padStart(2, "0")}:00 UTC: ${tokens === 0 ? "no usage" : `${formatCompact(tokens)} tokens`}`} />;
            })}
          </div>
        ))}
      </div>
    </Portlet>
  );
}
