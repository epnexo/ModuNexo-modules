import { getDb, getSetting } from "@modunexo/sdk";
import { cleanAddress, sendCommand } from "../lib/connect.ts";
import { parseGrain, type Grain } from "./buckets.ts";
import { chartFrom, parseChartQuery, parseFilters, periodStart, type Filters, type Period } from "./filters.ts";
import {
  type DailyRow,
  type HourRow,
  type ReceivedRow,
  type ModelRow,
  type ModelTokenRow,
  type ProjectRow,
  type SessionRow,
  type SkillRow,
  type Summary,
  type ToolActivityRow,
  type ToolInfo,
  type ToolRow,
  type ToolUseRow,
  getByModel,
  getByTool,
  getDaily,
  getHourly,
  getLastReceived,
  getModelTokens,
  getProjects,
  getRecentSessions,
  getSummary,
  getToolActivity,
  getTools,
  getTopSkills,
  getTopTools,
} from "./queries.ts";
import { parsePrices, type PriceTable } from "./metrics.ts";
import { overviewTools } from "./tools.ts";

type RawParams = Record<string, string | string[] | undefined>;

interface Common {
  /** The known CLIs first, then any other tool stored in the database. */
  tools: ToolInfo[];
  filters: Filters;
  problems: string[];
  since: string | null;
  today: string;
  summary: Summary;
  daily: DailyRow[];
  byTool: ToolRow[];
  activity: ToolActivityRow[];
  skills: SkillRow[];
  toolUse: ToolUseRow[];
  projects: ProjectRow[];
  sessions: SessionRow[];
  modelTokens: ModelTokenRow[];
  hours: HourRow[];
  /** When each tool's data last arrived; a tool that never sent anything has no entry. */
  received: ReceivedRow[];
  now: Date;
  grain: Grain;
  /** The prices an administrator entered in Settings; empty until they do. */
  prices: PriceTable;
  sendCommand: string | null;
}

export interface OverviewData extends Common {
  /** Set when an old link filtered by tool: the overview sends the visitor to that tool's page. */
  redirectTool: string | null;
}

export interface ToolPageData extends Common {
  tool: ToolInfo;
  byModel: ModelRow[];
}

/** The send command with the address an administrator saved in the settings, or null while none is saved. */
async function connectCommand(): Promise<string | null> {
  try {
    const address = cleanAddress(await getSetting("ai-usage", "platform_url"));
    return address === null ? null : sendCommand(address);
  } catch {
    return null;
  }
}

/** The price table from the settings, or an empty one when the setting is unset or the settings cannot be read. */
async function modelPrices(): Promise<PriceTable> {
  try {
    return parsePrices(await getSetting("ai-usage", "model_prices"));
  } catch {
    return parsePrices(null);
  }
}

/** Skills are fetched wide so that merging them across tools still leaves enough to rank. */
const SKILL_FETCH = 60;

async function common(raw: RawParams, now: Date, tool: string | null) {
  const db = getDb("ai-usage");
  const stored = await getTools(db);
  const tools = overviewTools(stored);
  const parsed = parseFilters(raw, tools.map((t) => t.slug));
  const since = periodStart(parsed.period, now);
  const filter = { since, tool: tool ?? parsed.tool };
  const [summary, daily, byTool, activity, skills, toolUse, projects, sessions, modelTokens, hours, received] = await Promise.all([
    getSummary(db, filter),
    getDaily(db, filter),
    getByTool(db, filter),
    getToolActivity(db, filter),
    getTopSkills(db, filter, SKILL_FETCH),
    getTopTools(db, filter, 12),
    getProjects(db, filter, 10),
    getRecentSessions(db, filter),
    getModelTokens(db, filter),
    getHourly(db, filter),
    getLastReceived(db),
  ]);
  return {
    db,
    parsed,
    base: {
      tools,
      filters: { period: parsed.period, tool: tool ?? null, grain: parseGrain(raw.grain) } satisfies Filters,
      problems: parsed.problems,
      since,
      today: now.toISOString().slice(0, 10),
      summary,
      daily,
      byTool,
      activity,
      skills,
      toolUse,
      projects,
      sessions,
      modelTokens,
      hours,
      received,
      now,
      grain: parseGrain(raw.grain),
      prices: await modelPrices(),
      sendCommand: await connectCommand(),
    } satisfies Common,
  };
}

export async function loadOverview(raw: RawParams, now: Date): Promise<OverviewData> {
  const { base, parsed } = await common(raw, now, null);
  // An old link such as /ai-usage?tool=codex now belongs on that tool's page.
  return { ...base, filters: { ...base.filters, tool: null }, redirectTool: parsed.tool };
}

/** The data for one tool's page, or null when the module does not know the tool. */
export async function loadToolPage(slug: string, raw: RawParams, now: Date): Promise<ToolPageData | null> {
  const stored = await getTools(getDb("ai-usage"));
  const tool = overviewTools(stored).find((t) => t.slug === slug);
  if (!tool) return null;
  const { base, db } = await common(raw, now, slug);
  const byModel = await getByModel(db, { since: base.since, tool: slug });
  return { ...base, tool, byModel };
}

export interface ChartData {
  period: Period;
  tool: string | null;
  /** First and last UTC day the chart draws, inclusive. */
  from: string;
  to: string;
  daily: DailyRow[];
}

/** The daily rows for one period (and optionally one tool), or the reason the request was refused. */
export async function loadChartData(params: URLSearchParams, now: Date): Promise<{ ok: true; data: ChartData } | { ok: false; error: string }> {
  const db = getDb("ai-usage");
  const known = overviewTools(await getTools(db)).map((t) => t.slug);
  const query = parseChartQuery(params, known);
  if (!query.ok) return query;
  const since = periodStart(query.period, now);
  const daily = await getDaily(db, { since, tool: query.tool });
  const today = now.toISOString().slice(0, 10);
  return { ok: true, data: { period: query.period, tool: query.tool, from: chartFrom(since, daily[0]?.day, today), to: today, daily } };
}
