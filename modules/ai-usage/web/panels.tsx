import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Mascot } from "./mascots.tsx";
import { HBars, Portlet, ToolName, styleOf, value, type HBarRow, type ToolStyle } from "./components.tsx";
import { PERIODS, PERIOD_LABELS, withFilters, type Filters, type Period } from "./filters.ts";
import { NOT_AVAILABLE, formatCompact, formatAgo, formatCount, formatPercent, formatUtcMinute } from "./format.ts";
import type { ProjectRow, ReceivedRow, ToolActivityRow, ToolInfo, ToolRow, ToolUseRow } from "./queries.ts";
import { failureRate, profileOf, toolPageHref, type MergedSkill, type TabItem } from "./tools.ts";

/** Period links for a page at `path`. The tool is not a filter here: each CLI has its own page. */
export function PeriodBar({ filters, path }: { filters: Filters; path: string }) {
  return (
    <nav className="au-seg" aria-label="Period">
      {PERIODS.map((period) => (
        <Link key={period} href={withFilters(filters, { period }, path)} aria-current={filters.period === period}>
          {PERIOD_LABELS[period]}
        </Link>
      ))}
    </nav>
  );
}

/** Switch between the overview and each tool without going back. Present on every page, with the current one marked. */
export function ToolTabs({ tabs, styles }: { tabs: TabItem[]; styles: Map<string, ToolStyle> }) {
  return (
    <nav className="au-seg au-tabs" aria-label="Views">
      {tabs.map((tab) => (
        <Link key={tab.slug ?? "overview"} href={tab.href} aria-current={tab.current ? "page" : undefined} className={tab.slug === null ? undefined : styleOf(styles, tab.slug).className}>
          {tab.slug === null ? null : <span className="au-dot" aria-hidden="true" />}
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

export interface ToolCardData {
  tool: ToolInfo;
  tokens: ToolRow | undefined;
  activity: ToolActivityRow | undefined;
}

/** One card per CLI: its mascot, a few numbers, and a link to its page. A CLI nothing was sent for is still listed. */
export function ToolCards({ cards, period, styles }: { cards: ToolCardData[]; period: Period; styles: Map<string, ToolStyle> }) {
  return (
    <section className="au-cards" aria-label="AI tools">
      {cards.map(({ tool, tokens, activity }) => {
        const profile = profileOf(tool.slug, tool.name);
        const style = styleOf(styles, tool.slug);
        const hasData = tokens !== undefined && (tokens.totalTokens > 0 || tokens.sessions > 0);
        return (
          <Link key={tool.slug} href={toolPageHref(tool.slug, period)} data-tool={tool.slug} className={`au-card ${style.className} ${hasData ? "" : "au-card-idle"}`}>
            <span className="au-card-stage">
              <Mascot slug={tool.slug} />
            </span>
            <span className="au-card-name">{profile.name}</span>
            {profile.tagline === "" ? null : <span className="au-card-tagline">{profile.tagline}</span>}
            {hasData ? (
              <dl className="au-card-stats">
                <div>
                  <dt>Tokens</dt>
                  <dd className="num">{formatCompact(tokens!.totalTokens)}</dd>
                </div>
                <div>
                  <dt>Sessions</dt>
                  <dd className="num">{formatCount(tokens!.sessions)}</dd>
                </div>
                <div>
                  <dt>Prompts</dt>
                  <dd className="num">{activity === undefined ? NOT_AVAILABLE : formatCount(activity.prompts)}</dd>
                </div>
                <div>
                  <dt>Tool calls</dt>
                  <dd className="num">{activity === undefined ? NOT_AVAILABLE : formatCompact(activity.toolCalls)}</dd>
                </div>
              </dl>
            ) : (
              <span className="au-card-empty">No data in this period</span>
            )}
            <span className="au-card-foot muted">{activity?.lastActiveAt ? `Last active ${formatUtcMinute(activity.lastActiveAt)} UTC` : "Open"}</span>
          </Link>
        );
      })}
    </section>
  );
}

const SKILL_BARS = 10;
const ESTIMATE_NOTE =
  "Claude Code and OpenCode report each skill they load. Codex and Pi do not, so a skill is counted there when a tool call reads its SKILL.md file; a plain read counts too (marked est.).";

/** Most used skills as bars. The bars carry an `est.` mark when the count may include plain reads of the skill file. */
export function TopSkills({ skills, perTool = false }: { skills: MergedSkill[]; perTool?: boolean }) {
  const total = skills.reduce((sum, skill) => sum + skill.calls, 0);
  const rows: HBarRow[] = skills.map((skill) => ({
    key: skill.skill,
    label: skill.skill,
    amount: skill.calls,
    share: total > 0 ? skill.calls / total : 0,
    tag: skill.estimated ? { text: "est.", title: "Counted from reads of the skill file, not from a skill event" } : undefined,
  }));
  const anyEstimated = skills.some((skill) => skill.estimated);
  return (
    <Portlet label="Most used skills" title="Most used skills" note={anyEstimated ? ESTIMATE_NOTE : `Calls that loaded a skill${perTool ? "" : ", across all tools"}.`}>
      {rows.length === 0 ? (
        <p className="muted">No skill was recorded in this period. Skills appear after the module is on version 0.6.0 and the logs are sent again.</p>
      ) : (
        <HBars label="Skill calls" rows={rows.slice(0, SKILL_BARS)} />
      )}
    </Portlet>
  );
}

/** The tools the AI called, with a failure rate where the log reports outcomes. */
export function TopTools({ rows, styles, showCli }: { rows: ToolUseRow[]; styles: Map<string, ToolStyle>; showCli: boolean }) {
  const total = rows.reduce((sum, row) => sum + row.calls, 0);
  return (
    <Portlet label="Most used tools" title="Most used tools" note="Tools the AI called. Failure rate counts only calls whose log reports an outcome; Codex does not.">
      {rows.length === 0 ? (
        <p className="muted">No tool call was recorded in this period. Names appear after the module is on version 0.6.0 and the logs are sent again.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                {showCli ? <th>CLI</th> : null}
                <th className="right">Calls</th>
                <th className="right">Share</th>
                <th className="right">Failed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const rate = failureRate(row);
                return (
                  <tr key={`${row.tool}/${row.name}`}>
                    <td title={row.name} className="au-clip">
                      {row.name}
                    </td>
                    {showCli ? (
                      <td>
                        <ToolName style={styleOf(styles, row.tool)} />
                      </td>
                    ) : null}
                    <td className="right num">{formatCount(row.calls)}</td>
                    <td className="right num">{formatPercent(total > 0 ? row.calls / total : 0)}</td>
                    <td className="right num">{rate === null ? <span className="au-na" title="This tool's log does not say whether a call failed">{NOT_AVAILABLE}</span> : formatPercent(rate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Portlet>
  );
}

/** Project labels (directory names) ranked by tokens. */
export function Projects({ rows, styles, showCli }: { rows: ProjectRow[]; styles: Map<string, ToolStyle>; showCli: boolean }) {
  return (
    <Portlet label="Projects" title="Projects" note="Directory names only, never full paths.">
      {rows.length === 0 ? (
        <p className="muted">No project was recorded in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                {showCli ? <th>CLI</th> : null}
                <th className="right">Tokens</th>
                <th className="right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.project ?? ""}/${row.tool}`}>
                  <td className="au-clip" title={row.project ?? undefined}>
                    {row.project ?? <span className="muted">No project</span>}
                  </td>
                  {showCli ? (
                    <td>
                      <ToolName style={styleOf(styles, row.tool)} />
                    </td>
                  ) : null}
                  <td className="right num">{value(row.totalTokens)}</td>
                  <td className="right num">{formatCount(row.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Portlet>
  );
}

/** The hero of a tool's page: mascot, name, what the tool is, and the way back. */
export function ToolHero({ tool, children }: { tool: ToolInfo; children?: ReactNode }) {
  const profile = profileOf(tool.slug, tool.name);
  return (
    <section className="au-hero" data-tool={tool.slug} aria-label={profile.name}>
      <div className="au-hero-stage">
        <Mascot slug={tool.slug} />
      </div>
      <div className="au-hero-text">
        <h1>{profile.name}</h1>
        {profile.tagline === "" ? null : <p>{profile.tagline}</p>}
        {children === undefined ? null : <Fragment>{children}</Fragment>}
      </div>
    </section>
  );
}

/** What both pages show when the database cannot be reached. */
export function Unavailable() {
  return (
    <div className="page-body">
      <div className="notice error" role="alert">
        <strong>AI usage data is unavailable</strong>
        The database could not be reached. Check that the platform database is up and try again.
      </div>
    </div>
  );
}

/**
 * When data last reached the platform. The overview lists each tool that ever sent something; a tool page passes
 * `only` for its own line. Hovering shows the exact UTC minute.
 */
export function LastReceived({ received, tools, now, only }: { received: ReceivedRow[]; tools: ToolInfo[]; now: Date; only?: string }) {
  const rows = received.filter((row) => only === undefined || row.tool === only);
  if (rows.length === 0) return <p className="muted au-received">No data received yet.</p>;
  const nameOf = (slug: string) => tools.find((tool) => tool.slug === slug)?.name ?? slug;
  return (
    <p className="muted au-received">
      Last data received:{" "}
      {rows.map((row, index) => (
        <Fragment key={row.tool}>
          {index === 0 ? null : " · "}
          {only === undefined ? `${nameOf(row.tool)} ` : null}
          <time dateTime={row.receivedAt.toISOString()} title={`${formatUtcMinute(row.receivedAt)} UTC`}>
            {formatAgo(row.receivedAt, now)}
          </time>
        </Fragment>
      ))}
    </p>
  );
}
