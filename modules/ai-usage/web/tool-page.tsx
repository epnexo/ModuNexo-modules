import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PAGE_PATH, PERIOD_LABELS } from "./filters.ts";
import { loadToolPage, type ToolPageData } from "./data.ts";
import { ByModelTable, CumulativeTokens, DailyCharts, EmptyState, Headline, ModelShare, Notice, RecentSessions, TokenSplit, toolStyles } from "./components.tsx";
import { formatCount } from "./format.ts";
import { groupModels } from "./group.ts";
import { PeriodBar, Projects, ToolHero, TopSkills, TopTools, Unavailable } from "./panels.tsx";
import { mergeSkills } from "./tools.ts";
import "./ai-usage.css";

type Params = Promise<{ tool: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The generated route re-exports only `default` and `metadata`, so the title cannot name the tool.
export const metadata: Metadata = { title: "AI usage" };

export default async function ToolUsagePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ tool: slug }, raw] = await Promise.all([params, searchParams]);

  let data: ToolPageData | null;
  try {
    data = await loadToolPage(slug, raw, new Date());
  } catch (error) {
    console.error("ai-usage: could not load a tool page:", (error as { code?: string }).code ?? (error as Error).name);
    return (
      <div className="au">
        <Unavailable />
      </div>
    );
  }
  if (data === null) notFound();

  const { tool, filters, problems, since, today, summary, daily, activity, skills, toolUse, projects, sessions, byModel } = data;
  const styles = toolStyles(data.tools);
  const path = `${PAGE_PATH}/${encodeURIComponent(slug)}`;
  const from = since ?? daily[0]?.day ?? today;
  const hasUsage = summary.sessions > 0 || summary.totalTokens > 0;
  const grouped = groupModels(byModel, 12);
  const mine = activity.find((row) => row.tool === slug);

  return (
    <div className={`au ${styles.get(slug)?.className ?? "au-t0"}`}>
      <header className="page-bar">
        <div className="page-bar-text">
          <p>Days are UTC.</p>
        </div>
        <div className="page-bar-tools">
          <PeriodBar filters={filters} path={path} />
        </div>
      </header>
      <div className="page-body">
        <ToolHero tool={tool}>
          {mine === undefined ? null : (
            <p className="muted">
              {formatCount(mine.prompts)} prompts and {formatCount(mine.toolCalls)} tool calls in {PERIOD_LABELS[filters.period].toLowerCase()}.
            </p>
          )}
        </ToolHero>
        {problems.map((problem) => (
          <Notice key={problem} title="Filter ignored">
            {problem}
          </Notice>
        ))}

        {!hasUsage ? (
          <EmptyState periodLabel={PERIOD_LABELS[filters.period]} toolName={tool.name} sendCommand={data.sendCommand} />
        ) : (
          <>
            <Headline summary={summary} />
            <DailyCharts daily={daily} tools={[tool]} styles={styles} from={from} to={today} />
            <div className="au-pair">
              <CumulativeTokens daily={daily} from={from} to={today} />
              <div className="au-stack">
                <TokenSplit summary={summary} />
                <ModelShare grouped={grouped} />
              </div>
            </div>
            <div className="au-pair">
              <TopSkills skills={mergeSkills(skills, 10)} perTool />
              <TopTools rows={toolUse} styles={styles} showCli={false} />
            </div>
            <div className="au-pair">
              <ByModelTable grouped={grouped} styles={styles} />
              <Projects rows={projects} styles={styles} showCli={false} />
            </div>
            <RecentSessions rows={sessions} styles={styles} />
          </>
        )}
      </div>
    </div>
  );
}
