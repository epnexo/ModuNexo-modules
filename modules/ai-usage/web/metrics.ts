/** Figures derived from the stored counters: cache hit rate, an estimated cost and the heat levels of the usage grid. */

interface CacheCounters {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/**
 * The share of input-side tokens (fresh input, cache reads and cache writes) that came from the cache. Null when the
 * tool reports no cache reads, or when nothing was counted: that is unknown, not a 0% rate.
 */
export function cacheHitRate(counters: CacheCounters): number | null {
  if (counters.cacheReadTokens === null) return null;
  const total = (counters.inputTokens ?? 0) + counters.cacheReadTokens + (counters.cacheWriteTokens ?? 0);
  return total > 0 ? counters.cacheReadTokens / total : null;
}

/** US dollars per million tokens. */
export interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface PriceTable {
  entries: { pattern: string; price: Price }[];
  /** Entries that could not be read. They are counted, never guessed. */
  ignored: number;
}

/**
 * Reads the `model_prices` setting: `model=input/cacheRead/cacheWrite/output` entries, separated by `;` or new
 * lines, in dollars per million tokens. A model ending in `*` matches every model that starts with the rest.
 */
export function parsePrices(text: unknown): PriceTable {
  const table: PriceTable = { entries: [], ignored: 0 };
  if (typeof text !== "string") return table;
  for (const raw of text.split(/[;\n]/)) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([^=\s]+)\s*=\s*(.+)$/.exec(line);
    const parts = match?.[2]!.split("/").map((part) => part.trim());
    const numbers = parts?.map((part) => (part === "" ? Number.NaN : Number(part)));
    if (!match || !numbers || numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
      table.ignored++;
      continue;
    }
    const [input, cacheRead, cacheWrite, output] = numbers as [number, number, number, number];
    table.entries.push({ pattern: match[1]!, price: { input, cacheRead, cacheWrite, output } });
  }
  return table;
}

/** The price of a model: the exact entry, else the longest `prefix*` entry that matches, else null. */
export function priceFor(table: PriceTable, model: string): Price | null {
  const exact = table.entries.find((entry) => entry.pattern === model);
  if (exact) return exact.price;
  let best: { length: number; price: Price } | null = null;
  for (const entry of table.entries) {
    if (!entry.pattern.endsWith("*")) continue;
    const prefix = entry.pattern.slice(0, -1);
    if (model.startsWith(prefix) && (best === null || prefix.length > best.length)) best = { length: prefix.length, price: entry.price };
  }
  return best?.price ?? null;
}

export interface ModelTokens {
  tool: string;
  model: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

export interface CostEstimate {
  /** Dollars, for the tokens that have a price. */
  cost: number;
  pricedTokens: number;
  /** Tokens of models with no price (or no model): they are not in `cost`. */
  unpricedTokens: number;
  byTool: Map<string, number>;
  unpricedByTool: Map<string, number>;
}

const sum = (row: ModelTokens) => (row.inputTokens ?? 0) + (row.cacheReadTokens ?? 0) + (row.cacheWriteTokens ?? 0) + (row.outputTokens ?? 0);

/** What the tokens would cost at API prices. It is an estimate: only models with an entry in the price table are counted. */
export function estimateCost(rows: ModelTokens[], table: PriceTable): CostEstimate {
  const estimate: CostEstimate = { cost: 0, pricedTokens: 0, unpricedTokens: 0, byTool: new Map(), unpricedByTool: new Map() };
  for (const row of rows) {
    const tokens = sum(row);
    const price = row.model === null ? null : priceFor(table, row.model);
    if (price === null) {
      estimate.unpricedTokens += tokens;
      estimate.unpricedByTool.set(row.tool, (estimate.unpricedByTool.get(row.tool) ?? 0) + tokens);
      continue;
    }
    const dollars = ((row.inputTokens ?? 0) * price.input + (row.cacheReadTokens ?? 0) * price.cacheRead + (row.cacheWriteTokens ?? 0) * price.cacheWrite + (row.outputTokens ?? 0) * price.output) / 1_000_000;
    estimate.cost += dollars;
    estimate.pricedTokens += tokens;
    estimate.byTool.set(row.tool, (estimate.byTool.get(row.tool) ?? 0) + dollars);
  }
  return estimate;
}

/** Dollars with thousands separators: whole dollars from 100 up, cents below. */
export function formatUsd(value: number): string {
  const digits = value >= 100 ? 0 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 0 for no activity, then 1 to 4 by share of the busiest cell. */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (max <= 0 || value <= 0) return 0;
  const share = value / max;
  return share <= 0.2 ? 1 : share <= 0.5 ? 2 : share <= 0.8 ? 3 : 4;
}
