import type { ModelRow } from "./queries.ts";

export interface ModelGroup {
  /** Null when the tool did not report a model. */
  model: string | null;
  totalTokens: number;
  /** Sessions never span tools, so adding per-tool session counts is exact within one model. */
  sessions: number;
  tools: { tool: string; totalTokens: number }[];
}

export interface GroupedModels {
  models: ModelGroup[];
  /** The models beyond `limit`, folded into one summary; null when nothing was folded. */
  other: { count: number; totalTokens: number } | null;
}

/** Merge per-tool model rows into one row per model, largest first, keeping at most `limit` rows. */
export function groupModels(rows: ModelRow[], limit: number): GroupedModels {
  const byModel = new Map<string | null, ModelGroup>();
  for (const row of rows) {
    const group = byModel.get(row.model) ?? { model: row.model, totalTokens: 0, sessions: 0, tools: [] };
    group.totalTokens += row.totalTokens;
    group.sessions += row.sessions;
    group.tools.push({ tool: row.tool, totalTokens: row.totalTokens });
    byModel.set(row.model, group);
  }

  const sorted = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  for (const group of sorted) group.tools.sort((a, b) => a.tool.localeCompare(b.tool));

  const tail = sorted.slice(limit);
  return {
    models: sorted.slice(0, limit),
    other: tail.length === 0 ? null : { count: tail.length, totalTokens: tail.reduce((sum, group) => sum + group.totalTokens, 0) },
  };
}
