import { describeDbError, getPool } from "@epnexo/core/pool";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PERIOD_LABELS, parseFilters, periodStart, type Filters } from "./filters.ts";
import { groupModels } from "./group.ts";
import {
  type DailyRow,
  type SessionRow,
  type Summary,
  type ToolInfo,
  type ToolRow,
  type ModelRow,
  getByModel,
  getByTool,
  getDaily,
  getRecentSessions,
  getSummary,
  getTools,
} from "./queries.ts";
import { ByModelTable, ByToolTable, CumulativeTokens, DailyCharts, EmptyState, FilterBar, Headline, ModelShare, TokenSplit, Notice, RecentSessions, toolStyles } from "./components.tsx";
import "./ai-usage.css";

export const metadata: Metadata = { title: "AI usage" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

interface PageData {
  tools: ToolInfo[];
  filters: Filters;
  problems: string[];
  since: string | null;
  today: string;
  summary: Summary;
  daily: DailyRow[];
  byTool: ToolRow[];
  byModel: ModelRow[];
  sessions: SessionRow[];
}

async function loadPageData(raw: Awaited<SearchParams>, now: Date): Promise<PageData> {
  const db = getPool();
  const tools = await getTools(db);
  const parsed = parseFilters(raw, tools.map((tool) => tool.slug));
  const since = periodStart(parsed.period, now);
  const filter = { since, tool: parsed.tool };
  const [summary, daily, byTool, byModel, sessions] = await Promise.all([
    getSummary(db, filter),
    getDaily(db, filter),
    getByTool(db, filter),
    getByModel(db, filter),
    getRecentSessions(db, filter),
  ]);
  return {
    tools,
    filters: { period: parsed.period, tool: parsed.tool },
    problems: parsed.problems,
    since,
    today: now.toISOString().slice(0, 10),
    summary,
    daily,
    byTool,
    byModel,
    sessions,
  };
}

function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="page-bar">
      <div className="page-bar-text">
        <h1>AI usage</h1>
        <p>Token consumption of the AI coding CLIs on this machine. Days are UTC.</p>
      </div>
      {children === undefined ? null : <div className="page-bar-tools">{children}</div>}
    </header>
  );
}

export default async function AiUsagePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;

  let data: PageData;
  try {
    data = await loadPageData(raw, new Date());
  } catch (error) {
    // Log only the error code: driver messages can include the host and database name.
    console.error("ai-usage: could not load the page:", (error as { code?: string }).code ?? (error as Error).name);
    return (
      <div className="au">
        <Header />
        <div className="page-body">
          <Notice tone="error" title="AI usage data is unavailable">
            {describeDbError(error).message}
          </Notice>
        </div>
      </div>
    );
  }

  const { tools, filters, problems, since, today, summary, daily, byTool, byModel, sessions } = data;
  const styles = toolStyles(tools);
  const shownTools = filters.tool === null ? tools : tools.filter((tool) => tool.slug === filters.tool);
  const from = since ?? daily[0]?.day ?? today;
  const hasUsage = summary.sessions > 0 || summary.totalTokens > 0;
  const grouped = groupModels(byModel, 12);

  return (
    <div className="au">
      <Header>
        <FilterBar filters={filters} tools={tools} />
      </Header>
      <div className="page-body">
        {problems.map((problem) => (
          <Notice key={problem} title="Filter ignored">
            {problem}
          </Notice>
        ))}

        {!hasUsage ? (
          <EmptyState periodLabel={PERIOD_LABELS[filters.period]} toolName={shownTools.length === 1 ? shownTools[0]!.name : null} />
        ) : (
          <div className="au-layout">
            <Headline summary={summary} />
            <DailyCharts daily={daily} tools={shownTools} styles={styles} from={from} to={today} />
            <CumulativeTokens daily={daily} from={from} to={today} />
            <TokenSplit summary={summary} />
            <ModelShare grouped={grouped} />
            <ByToolTable rows={byTool} styles={styles} />
            <ByModelTable grouped={grouped} styles={styles} />
            <RecentSessions rows={sessions} styles={styles} />
          </div>
        )}
      </div>
    </div>
  );
}
