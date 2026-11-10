import { DEFAULT_GRAIN, type Grain } from "./buckets.ts";

export const PERIODS = ["7d", "30d", "90d", "all"] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = "30d";

export const PERIOD_LABELS: Record<Period, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

export const PAGE_PATH = "/ai-usage";
/** The route that answers the chart's daily rows for one period, so the chart can change period without the page reloading. */
export const CHART_DATA_PATH = "/ai-usage/data/daily";

export interface Filters {
  period: Period;
  /** Tool slug, or null for all tools. */
  tool: string | null;
  /** What one bar of the daily chart covers; left out means daily. */
  grain?: Grain;
}

export interface ParsedFilters extends Filters {
  /** One message per query value that was ignored, safe to show to the viewer. */
  problems: string[];
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const picked = Array.isArray(value) ? value[0] : value;
  return picked === "" ? undefined : picked;
}

const shown = (value: string) => (value.length > 40 ? `${value.slice(0, 40)}...` : value);

/** Read the query string. Anything unknown falls back to the default and is reported, never trusted. */
export function parseFilters(raw: RawParams, knownTools: string[]): ParsedFilters {
  const problems: string[] = [];
  let period = DEFAULT_PERIOD;
  let tool: string | null = null;

  const rawPeriod = first(raw.period);
  if (rawPeriod !== undefined) {
    if ((PERIODS as readonly string[]).includes(rawPeriod)) period = rawPeriod as Period;
    else problems.push(`Unknown period "${shown(rawPeriod)}"; showing ${PERIOD_LABELS[DEFAULT_PERIOD].toLowerCase()}.`);
  }

  const rawTool = first(raw.tool);
  if (rawTool !== undefined) {
    if (knownTools.includes(rawTool)) tool = rawTool;
    else problems.push(`Unknown tool "${shown(rawTool)}"; showing all tools.`);
  }

  return { period, tool, problems };
}

const WINDOW_DAYS: Record<Exclude<Period, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** First UTC day of the period, counting today as its last day. Null means no lower bound. */
export function periodStart(period: Period, now: Date): string | null {
  if (period === "all") return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (WINDOW_DAYS[period] - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** A link to the page with the current filters changed by `patch`. Defaults are left out to keep URLs short. */
export function withFilters(current: Filters, patch: { period?: Period; tool?: string | null; grain?: Grain }, path: string = PAGE_PATH): string {
  const period = patch.period ?? current.period;
  const tool = patch.tool === undefined ? current.tool : patch.tool;
  const grain = patch.grain ?? current.grain ?? DEFAULT_GRAIN;
  const params = new URLSearchParams();
  if (period !== DEFAULT_PERIOD) params.set("period", period);
  if (tool !== null) params.set("tool", tool);
  if (grain !== DEFAULT_GRAIN) params.set("grain", grain);
  const query = params.toString();
  return query === "" ? path : `${path}?${query}`;
}

const KNOWN_TOOL_SLOTS: Record<string, number> = { "claude-code": 1, codex: 2, pi: 3, opencode: 4 };
const LAST_SLOT = 8;

/**
 * The categorical color slot (1 to 8) of a tool, or 0 for the neutral fallback. Known tools keep a fixed slot
 * so filtering never repaints them; tools added later take the next free slots in `allTools` order.
 */
export function toolColorSlot(slug: string, allTools: string[]): number {
  const fixed = KNOWN_TOOL_SLOTS[slug];
  if (fixed !== undefined) return fixed;
  const later = allTools.filter((tool) => KNOWN_TOOL_SLOTS[tool] === undefined);
  const slot = Object.keys(KNOWN_TOOL_SLOTS).length + 1 + later.indexOf(slug);
  return slot > LAST_SLOT || later.indexOf(slug) === -1 ? 0 : slot;
}

/**
 * The query of the chart's data route. Unlike a page, which falls back to the default and tells the viewer, a call
 * that names an unknown period or tool is refused: whoever asked wants those rows, not other ones.
 */
export function parseChartQuery(params: URLSearchParams, knownTools: string[]): { ok: true; period: Period; tool: string | null } | { ok: false; error: string } {
  const period = params.get("period") ?? DEFAULT_PERIOD;
  if (!(PERIODS as readonly string[]).includes(period)) return { ok: false, error: `Unknown period "${shown(period)}".` };
  const tool = params.get("tool");
  if (tool !== null && tool !== "" && !knownTools.includes(tool)) return { ok: false, error: `Unknown tool "${shown(tool)}".` };
  return { ok: true, period: period as Period, tool: tool === null || tool === "" ? null : tool };
}

/** The first day the chart draws: the period's start, or for all time the first day with data, or today when there is none. */
export function chartFrom(since: string | null, firstDay: string | undefined, today: string): string {
  return since ?? firstDay ?? today;
}
