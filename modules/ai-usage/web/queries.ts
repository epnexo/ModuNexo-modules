/**
 * SQL for the AI usage page. Every function takes any object with a `query` method (a `pg.Pool` in the app,
 * the test pool in tests) and returns plain typed rows. Counters a tool does not report stay null.
 */

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface QueryFilter {
  /** First UTC day to include (`YYYY-MM-DD`), or null for no lower bound. */
  since: string | null;
  /** Tool slug, or null for all tools. */
  tool: string | null;
}

export interface ToolInfo {
  slug: string;
  name: string;
}

/** Token counters. Each component is null when no event in the selection reported it. */
export interface TokenCounters {
  totalTokens: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

export interface Summary extends TokenCounters {
  /** Sessions with at least one usage event in the selection. */
  sessions: number;
  activeDays: number;
}

export interface DailyRow {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  tool: string;
  totalTokens: number;
}

export interface ToolRow extends TokenCounters {
  tool: string;
  name: string;
  sessions: number;
  activeDays: number;
}

export interface ModelRow {
  model: string | null;
  tool: string;
  totalTokens: number;
  sessions: number;
}

export interface SessionRow {
  id: number;
  tool: string;
  externalId: string;
  startedAt: Date;
  projectLabel: string | null;
  /** Set only when every event of the session used the same model. */
  model: string | null;
  events: number;
  totalTokens: number;
  /** Prompts typed by the user. The view reports 0 when a tool does not provide this, so it cannot be told from none. */
  messageCount: number;
  toolCallCount: number;
}

// `since` is a UTC day: compare against UTC midnight so the boundary does not depend on the session time zone.
const EVENT_FILTER = `($1::date is null or e.occurred_at >= ($1::date::timestamp at time zone 'UTC')) and ($2::text is null or t.slug = $2::text)`;

/** Postgres returns bigint and numeric sums as strings; the values here stay far below 2^53. */
function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function required(value: unknown): number {
  return num(value) ?? 0;
}

function counters(row: Record<string, unknown>): TokenCounters {
  return {
    totalTokens: required(row.total_tokens),
    inputTokens: num(row.input_tokens),
    cacheReadTokens: num(row.cache_read_tokens),
    cacheWriteTokens: num(row.cache_write_tokens),
    outputTokens: num(row.output_tokens),
  };
}

const COUNTER_SUMS = `
  coalesce(sum(e.total_tokens), 0) as total_tokens,
  sum(e.input_tokens) as input_tokens,
  sum(e.cache_read_tokens) as cache_read_tokens,
  sum(e.cache_write_tokens) as cache_write_tokens,
  sum(e.output_tokens) as output_tokens`;

export async function getTools(db: Queryable): Promise<ToolInfo[]> {
  const { rows } = await db.query("select slug, name from ai_usage.tools order by id");
  return rows.map((row) => ({ slug: String(row.slug), name: String(row.name) }));
}

export async function getSummary(db: Queryable, filter: QueryFilter): Promise<Summary> {
  const { rows } = await db.query(
    `select ${COUNTER_SUMS},
            count(distinct e.session_id) as sessions,
            count(distinct (e.occurred_at at time zone 'UTC')::date) as active_days
       from ai_usage.usage_events e
       join ai_usage.tools t on t.id = e.tool_id
      where ${EVENT_FILTER}`,
    [filter.since, filter.tool],
  );
  const row = rows[0] ?? {};
  return { ...counters(row), sessions: required(row.sessions), activeDays: required(row.active_days) };
}

/** Tokens per UTC day and tool, from the `daily_usage` view. Days with no events have no row. */
export async function getDaily(db: Queryable, filter: QueryFilter): Promise<DailyRow[]> {
  const { rows } = await db.query(
    `select to_char(day, 'YYYY-MM-DD') as day, tool, sum(total_tokens) as total_tokens
       from ai_usage.daily_usage
      where ($1::date is null or day >= $1::date) and ($2::text is null or tool = $2::text)
      group by day, tool
      order by day, tool`,
    [filter.since, filter.tool],
  );
  return rows.map((row) => ({ day: String(row.day), tool: String(row.tool), totalTokens: required(row.total_tokens) }));
}

export async function getByTool(db: Queryable, filter: QueryFilter): Promise<ToolRow[]> {
  const { rows } = await db.query(
    `select t.slug as tool, t.name, ${COUNTER_SUMS},
            count(distinct e.session_id) as sessions,
            count(distinct (e.occurred_at at time zone 'UTC')::date) as active_days
       from ai_usage.usage_events e
       join ai_usage.tools t on t.id = e.tool_id
      where ${EVENT_FILTER}
      group by t.id, t.slug, t.name
      order by sum(e.total_tokens) desc, t.slug`,
    [filter.since, filter.tool],
  );
  return rows.map((row) => ({
    tool: String(row.tool),
    name: String(row.name),
    ...counters(row),
    sessions: required(row.sessions),
    activeDays: required(row.active_days),
  }));
}

/** One row per model and tool: a model served through two tools appears twice. */
export async function getByModel(db: Queryable, filter: QueryFilter): Promise<ModelRow[]> {
  const { rows } = await db.query(
    `select e.model, t.slug as tool, coalesce(sum(e.total_tokens), 0) as total_tokens, count(distinct e.session_id) as sessions
       from ai_usage.usage_events e
       join ai_usage.tools t on t.id = e.tool_id
      where ${EVENT_FILTER}
      group by e.model, t.slug
      order by sum(e.total_tokens) desc, t.slug, e.model nulls last`,
    [filter.since, filter.tool],
  );
  return rows.map((row) => ({
    model: row.model === null ? null : String(row.model),
    tool: String(row.tool),
    totalTokens: required(row.total_tokens),
    sessions: required(row.sessions),
  }));
}

/** Newest sessions that started inside the selection. */
export async function getRecentSessions(db: Queryable, filter: QueryFilter, limit = 25): Promise<SessionRow[]> {
  const { rows } = await db.query(
    `select s.id, s.tool, s.external_id, s.started_at, s.project_label, s.model, s.events, s.total_tokens,
            s.message_count, s.tool_call_count
       from ai_usage.session_summary s
      where ($1::date is null or s.started_at >= ($1::date::timestamp at time zone 'UTC')) and ($2::text is null or s.tool = $2::text)
      order by s.started_at desc, s.id desc
      limit $3`,
    [filter.since, filter.tool, limit],
  );
  return rows.map((row) => ({
    id: required(row.id),
    tool: String(row.tool),
    externalId: String(row.external_id),
    startedAt: row.started_at as Date,
    projectLabel: row.project_label === null ? null : String(row.project_label),
    model: row.model === null ? null : String(row.model),
    events: required(row.events),
    totalTokens: required(row.total_tokens),
    messageCount: required(row.message_count),
    toolCallCount: required(row.tool_call_count),
  }));
}
