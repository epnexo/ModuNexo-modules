import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { PAGE_PATH, PERIOD_LABELS, withFilters } from "./filters.ts";
import { estimateCost } from "./metrics.ts";
import { loadOverview, type OverviewData } from "./data.ts";
import { ByToolTable, CumulativeTokens, DailyCharts, EmptyState, Headline, Notice, RecentSessions, UsageHours, toolStyles, type CostView } from "./components.tsx";
import { LastReceived, PeriodBar, Projects, ToolCards, ToolTabs, TopSkills, TopTools, Unavailable } from "./panels.tsx";
import { mergeSkills, toolPageHref, toolTabs } from "./tools.ts";
import "./ai-usage.css";

export const metadata: Metadata = { title: "AI usage" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="page-bar">
      <div className="page-bar-text">
        <h1>AI usage</h1>
        <p>What the AI coding CLIs on your machines consumed and did. Days are UTC. Open a tool for everything about it.</p>
      </div>
      {children === undefined ? null : <div className="page-bar-tools">{children}</div>}
    </header>
  );
}

export default async function AiUsagePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;

  let data: OverviewData;
  try {
    data = await loadOverview(raw, new Date());
  } catch (error) {
    // Log only the error code: driver messages can include the host and database name.
    console.error("ai-usage: could not load the overview:", (error as { code?: string }).code ?? (error as Error).name);
    return (
      <div className="au">
        <Header />
        <Unavailable />
      </div>
    );
  }
  if (data.redirectTool !== null) redirect(toolPageHref(data.redirectTool, data.filters.period));

  const { tools, filters, problems, since, today, summary, daily, byTool, activity, skills, toolUse, projects, sessions, modelTokens, hours, prices } = data;
  const cost: CostView = { estimate: estimateCost(modelTokens, prices), hasPrices: prices.entries.length > 0 };
  const styles = toolStyles(tools);
  const from = since ?? daily[0]?.day ?? today;
  const hasUsage = summary.sessions > 0 || summary.totalTokens > 0;
  const withData = tools.filter((tool) => daily.some((row) => row.tool === tool.slug));
  const cards = tools.map((tool) => ({ tool, tokens: byTool.find((row) => row.tool === tool.slug), activity: activity.find((row) => row.tool === tool.slug) }));

  return (
    <div className="au">
      <Header>
        <PeriodBar filters={filters} path={PAGE_PATH} />
      </Header>
      <div className="page-body">
        <ToolTabs tabs={toolTabs(tools, null, filters.period)} styles={styles} />
        <LastReceived received={data.received} tools={tools} now={data.now} />
        {problems.map((problem) => (
          <Notice key={problem} title="Filter ignored">
            {problem}
          </Notice>
        ))}

        {!hasUsage ? (
          <>
            <EmptyState periodLabel={PERIOD_LABELS[filters.period]} toolName={null} sendCommand={data.sendCommand} />
            <ToolCards cards={cards} period={filters.period} styles={styles} />
          </>
        ) : (
          <>
            <Headline summary={summary} cost={cost} />
            <ToolCards cards={cards} period={filters.period} styles={styles} />
            <DailyCharts daily={daily} tools={withData.length > 0 ? withData : tools} styles={styles} from={from} to={today} grain={data.grain} grainHref={(grain) => withFilters(filters, { grain }, PAGE_PATH)} />
            <div className="au-pair">
              <TopSkills skills={mergeSkills(skills, 10)} />
              <TopTools rows={toolUse} styles={styles} showCli />
            </div>
            <CumulativeTokens daily={daily} from={from} to={today} />
            <UsageHours rows={hours} />
            <div className="au-pair">
              <ByToolTable rows={byTool} styles={styles} cost={cost} />
              <Projects rows={projects} styles={styles} showCli />
            </div>
            <RecentSessions rows={sessions} styles={styles} />
          </>
        )}
      </div>
    </div>
  );
}
