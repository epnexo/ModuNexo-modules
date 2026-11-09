import { DEFAULT_PERIOD, PAGE_PATH, type Period } from "./filters.ts";
import type { SkillRow, ToolInfo, ToolUseRow } from "./queries.ts";

/** How a CLI's skills are found: its log has a skill event (exact), or the skill is read from a SKILL.md path (estimated). */
export type SkillSource = "exact" | "estimated" | "none";

export interface ToolProfile {
  slug: string;
  name: string;
  tagline: string;
  skills: SkillSource;
  /** False for a tool the module has no profile for. */
  known: boolean;
}

/** The CLIs the module has collectors for, in the order the overview lists them. */
export const KNOWN_TOOLS: ToolProfile[] = [
  { slug: "claude-code", name: "Claude Code", tagline: "Anthropic's coding agent", skills: "exact", known: true },
  { slug: "codex", name: "Codex", tagline: "OpenAI's coding agent", skills: "estimated", known: true },
  { slug: "opencode", name: "OpenCode", tagline: "Open source coding agent", skills: "exact", known: true },
  { slug: "pi", name: "Pi", tagline: "Minimal coding agent", skills: "estimated", known: true },
];

/** The profile of a tool. The name the collector stored wins over the built-in one. */
export function profileOf(slug: string, storedName?: string): ToolProfile {
  const known = KNOWN_TOOLS.find((tool) => tool.slug === slug);
  if (known) return { ...known, name: storedName ?? known.name };
  return { slug, name: storedName ?? slug, tagline: "", skills: "none", known: false };
}

/** Every known CLI first, even one nothing was sent for yet, then any other tool stored in the database. */
export function overviewTools(stored: ToolInfo[]): ToolInfo[] {
  const byName = new Map(stored.map((tool) => [tool.slug, tool.name]));
  const known = KNOWN_TOOLS.map((tool) => ({ slug: tool.slug, name: byName.get(tool.slug) ?? tool.name }));
  const others = stored.filter((tool) => !KNOWN_TOOLS.some((known) => known.slug === tool.slug));
  return [...known, ...others];
}

/** The page of one tool. The period is left out when it is the default, like everywhere else. */
export function toolPageHref(slug: string, period: Period): string {
  const path = `${PAGE_PATH}/${encodeURIComponent(slug)}`;
  return period === DEFAULT_PERIOD ? path : `${path}?period=${period}`;
}

export interface MergedSkill {
  skill: string;
  calls: number;
  sessions: number;
  tools: string[];
  /** Some of its calls come from a tool with no skill event, so the count may include a plain read of the file. */
  estimated: boolean;
}

/** One row per skill across tools, most used first. `sessions` adds up per tool: the same skill in two tools counts twice. */
export function mergeSkills(rows: SkillRow[], limit: number): MergedSkill[] {
  const merged = new Map<string, MergedSkill>();
  for (const row of rows) {
    const entry = merged.get(row.skill) ?? { skill: row.skill, calls: 0, sessions: 0, tools: [], estimated: false };
    entry.calls += row.calls;
    entry.sessions += row.sessions;
    if (!entry.tools.includes(row.tool)) entry.tools.push(row.tool);
    if (profileOf(row.tool).skills === "estimated") entry.estimated = true;
    merged.set(row.skill, entry);
  }
  return [...merged.values()].sort((a, b) => b.calls - a.calls || a.skill.localeCompare(b.skill)).slice(0, limit);
}

/** Failed calls over the calls whose outcome the log reports; null when it reports none. */
export function failureRate(row: Pick<ToolUseRow, "calls" | "failed" | "reported">): number | null {
  return row.reported === 0 ? null : row.failed / row.reported;
}
