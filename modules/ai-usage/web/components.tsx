import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { type ChartTool, CumulativeLine, StackedBars } from "./chart-client.tsx";
import { barFractions, cumulative, fillDays, stackShares, topWithOther } from "./chart.ts";
import { PERIODS, PERIOD_LABELS, type Filters, toolColorSlot, withFilters } from "./filters.ts";
import { NOT_AVAILABLE, formatCompact, formatCount, formatPercent, formatUtcMinute } from "./format.ts";
import type { GroupedModels } from "./group.ts";
import type { DailyRow, SessionRow, Summary, ToolInfo, ToolRow } from "./queries.ts";

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
function styleOf(styles: Map<string, ToolStyle>, slug: string): ToolStyle {
  return styles.get(slug) ?? { slug, name: slug, className: "au-t0" };
}

/** The shell's portlet pattern: a header band holding the heading, a body holding the note and the content. */
function Portlet({ label, title, note, className, children }: { label: string; title: string; note?: ReactNode; className?: string; children: ReactNode }) {
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

const value = (n: number | null, format: (n: number) => string = formatCompact): ReactNode => (n === null ? <Na /> : format(n));

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

export function EmptyState({ periodLabel, toolName }: { periodLabel: string; toolName: string | null }) {
  return (
    <Portlet label="No usage recorded" title="No usage recorded" className="au-empty">
      <p>
        {toolName === null ? "No tool reported" : `${toolName} reported`} token usage for {periodLabel.toLowerCase()}. Try a longer period
        {toolName === null ? "" : " or another tool"}, or run <code>npm run ai-usage:ingest</code> to load newer sessions.
      </p>
    </Portlet>
  );
}

export function Headline({ summary }: { summary: Summary }) {
  const cards: { label: string; value: string; sub: string; title?: string }[] = [
    { label: "Total tokens", value: formatCompact(summary.totalTokens), sub: formatCount(summary.totalTokens), title: `${formatCount(summary.totalTokens)} tokens` },
    { label: "Sessions", value: formatCount(summary.sessions), sub: "with recorded usage" },
    { label: "Active days", value: formatCount(summary.activeDays), sub: "UTC days with usage" },
    { label: "Output tokens", value: formatCompact(summary.outputTokens), sub: `Fresh input ${formatCompact(summary.inputTokens)}` },
  ];
  return (
    <dl className="kpis" aria-label="Headline numbers">
      {cards.map((card, i) => (
        <div key={card.label} className={`kpi kpi-${i + 1}`}>
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

interface HBarRow {
  key: string;
  label: string;
  amount: number | null;
  /** Share of the whole, 0 to 1; null when the part is not reported. */
  share: number | null;
  /** A fold of several items, drawn in the neutral color. */
  other?: boolean;
  /** The label is not a real name (a model the tool did not report). */
  quiet?: boolean;
}

/** Horizontal bars as plain HTML so labels keep their real size on a phone. Length is relative to the largest bar; the value and share are printed. */
function HBars({ rows, label }: { rows: HBarRow[]; label: string }) {
  const fractions = barFractions(rows.map((row) => row.amount));
  return (
    <ul className="au-hbars" aria-label={label}>
      {rows.map((row, i) => {
        const fraction = fractions[i] ?? null;
        return (
          <li key={row.key} className={`au-hbar ${row.other === true ? "au-hbar-other" : ""}`}>
            <span className={`au-hbar-label ${row.quiet === true ? "muted" : ""}`} title={row.label}>
              {row.label}
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

/** Per-tool token series over every UTC day of the period, null where the tool recorded nothing. */
function perToolDays(daily: DailyRow[], tools: ToolInfo[], from: string, to: string) {
  const byTool = new Map<string, { day: string; value: number }[]>();
  for (const row of daily) byTool.set(row.tool, [...(byTool.get(row.tool) ?? []), { day: row.day, value: row.totalTokens }]);
  return tools.map((tool) => fillDays(byTool.get(tool.slug) ?? [], from, to));
}

export function DailyCharts({
  daily,
  tools,
  styles,
  from,
  to,
}: {
  daily: DailyRow[];
  tools: ToolInfo[];
  styles: Map<string, ToolStyle>;
  /** First and last UTC day shown, inclusive. */
  from: string;
  to: string;
}) {
  const perTool = perToolDays(daily, tools, from, to);
  const days = (perTool[0] ?? []).map((entry, i) => ({ day: entry.day, parts: perTool.map((series) => series[i]!.value) }));
  const chartTools: ChartTool[] = tools.map((tool) => ({ slug: tool.slug, name: tool.name, className: styleOf(styles, tool.slug).className }));
  const totals = perTool.map((series) => series.reduce((sum, d) => sum + (d.value ?? 0), 0));

  const activeDays = [...new Set(daily.map((row) => row.day))].sort().reverse();
  const cell = new Map(daily.map((row) => [`${row.day}|${row.tool}`, row.totalTokens]));

  return (
    <Portlet label="Tokens per day" title="Tokens per day" className="au-chart" note="Days are UTC. Gaps are days with no recorded usage. Hover a bar, or use the arrow keys, to read its day.">
      <ul className="au-legend" aria-label="Tools">
        {tools.map((tool, i) => (
          <li key={tool.slug} className={chartTools[i]!.className}>
            <span className="au-key" aria-hidden="true" />
            {tool.name}
            <span className="muted num">{formatCompact(totals[i] ?? 0)}</span>
          </li>
        ))}
      </ul>
      <StackedBars days={days} tools={chartTools} />

      <details>
        <summary>Show as table</summary>
        <div className="au-scroll table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day (UTC)</th>
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
                  <td className="num">{day}</td>
                  {tools.map((tool) => {
                    const amount = cell.get(`${day}|${tool.slug}`);
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
    </Portlet>
  );
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

function Share({ amount, total, className }: { amount: number; total: number; className?: string }) {
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

export function ByToolTable({ rows, styles }: { rows: ToolRow[]; styles: Map<string, ToolStyle> }) {
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
