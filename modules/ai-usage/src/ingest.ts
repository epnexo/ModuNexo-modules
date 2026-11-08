import { createHash } from "node:crypto";
import type pg from "pg";
import type { ActivityItem, Collector, ParseResult, SessionRecord, SourceCounters, SourceFile, UsageRecord } from "./collector.ts";

/** A failed file, identified without its path: the tool and a prefix of the path hash, plus the error code or name. */
export interface FailedFile {
  id: string;
  reason: string;
}

export interface IngestReport {
  tool: string;
  filesScanned: number;
  /** Files whose size and modification time match the last run. */
  filesSkipped: number;
  /** Files that could not be read or stored. The rest of the run is unaffected, and they are retried next run. */
  filesFailed: number;
  failedFiles: FailedFile[];
  sessionsInserted: number;
  eventsInserted: number;
  /** Total tokens of the events inserted by this run. */
  tokensInserted: number;
  /** Total tokens of every event of this tool in the database after the run. */
  tokensInDatabase: number;
}

export interface IngestOptions {
  /** Rows per statement. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 1000;
const FAILED_ID_LENGTH = 12;

interface StateRow {
  size_bytes: string;
  mtime_ms: string;
  byte_offset: string;
  message_count: number;
  tool_call_count: number;
  duration_ms: string;
  parser_state: unknown;
  session_id: string | null;
}

/**
 * Run collectors and store what they find. Idempotent: events are upserted by their natural key, files
 * that did not change are skipped, and a changed file is read from the last complete line it was read to.
 * Each file is written in one transaction together with its progress, so a failure leaves nothing half-applied.
 * A file that fails is reported and skipped; the run continues and the caller decides what a failure means.
 */
export async function ingest(pool: pg.Pool, collectors: Collector[], options: IngestOptions = {}): Promise<IngestReport[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const reports: IngestReport[] = [];
  for (const collector of collectors) {
    const toolId = await ensureTool(pool, collector);
    const report: IngestReport = {
      tool: collector.toolId,
      filesScanned: 0,
      filesSkipped: 0,
      filesFailed: 0,
      failedFiles: [],
      sessionsInserted: 0,
      eventsInserted: 0,
      tokensInserted: 0,
      tokensInDatabase: 0,
    };
    for (const file of await collector.discover()) {
      report.filesScanned++;
      try {
        await ingestFile(pool, collector, toolId, file, batchSize, report);
      } catch (error) {
        // One bad file must not stop the run. Only a code or class name is kept: messages can contain paths.
        report.filesFailed++;
        report.failedFiles.push({
          id: `${collector.toolId}:${sourceKey(file.path).slice(0, FAILED_ID_LENGTH)}`,
          reason: (error as { code?: string }).code ?? (error as Error).name ?? "Error",
        });
      }
    }
    const total = await pool.query("select coalesce(sum(total_tokens), 0) as total from ai_usage.usage_events where tool_id = $1", [toolId]);
    report.tokensInDatabase = Number(total.rows[0].total);
    reports.push(report);
  }
  return reports;
}

async function ensureTool(pool: pg.Pool, collector: Collector): Promise<number> {
  await pool.query("insert into ai_usage.tools (slug, name) values ($1, $2) on conflict (slug) do nothing", [collector.toolId, collector.toolName]);
  const row = await pool.query("select id from ai_usage.tools where slug = $1", [collector.toolId]);
  return row.rows[0].id as number;
}

/** The path is hashed because it contains project and session names. */
const sourceKey = (path: string) => createHash("sha256").update(path).digest("hex");

async function ingestFile(
  pool: pg.Pool,
  collector: Collector,
  toolId: number,
  file: SourceFile,
  batchSize: number,
  report: IngestReport,
): Promise<void> {
  const key = sourceKey(file.path);
  const found = await pool.query<StateRow>("select * from ai_usage.ingest_state where tool_id = $1 and source_key = $2", [toolId, key]);
  const state = found.rows[0];

  if (state && Number(state.size_bytes) === file.size && Number(state.mtime_ms) === file.mtimeMs) {
    report.filesSkipped++;
    return;
  }
  // A file that shrank was rewritten, so it is read again from the start and its counters start over.
  const resumable = state !== undefined && file.size >= Number(state.byte_offset);
  const parsed = await collector.parse(file, resumable ? { offset: Number(state.byte_offset), state: state.parser_state } : { offset: 0, state: null });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionIds = await upsertSessions(client, toolId, parsed.sessions, batchSize, report);
    await upsertEvents(client, toolId, sessionIds, mergeDuplicateEvents(parsed.usage), batchSize, report);
    const counters = parsed.activity ? await storeActivity(client, toolId, key, parsed.activity, sessionIds, batchSize) : undefined;
    await saveState(client, toolId, key, file, parsed, sessionIds, resumable ? state : undefined, counters);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function upsertSessions(
  client: pg.PoolClient,
  toolId: number,
  sessions: SessionRecord[],
  batchSize: number,
  report: IngestReport,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const batch of chunks(sessions, batchSize)) {
    const result = await client.query(
      `insert into ai_usage.sessions (tool_id, external_id, started_at, ended_at, project_label)
       select $1, * from unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[])
       on conflict (tool_id, external_id) do update set
         started_at = least(sessions.started_at, excluded.started_at),
         ended_at = greatest(sessions.ended_at, excluded.ended_at),
         project_label = coalesce(sessions.project_label, excluded.project_label)
       returning id, external_id, (xmax = 0) as inserted`,
      [
        toolId,
        batch.map((s) => s.externalId),
        batch.map((s) => s.startedAt.toISOString()),
        batch.map((s) => s.endedAt.toISOString()),
        batch.map((s) => s.projectLabel),
      ],
    );
    for (const row of result.rows) {
      ids.set(row.external_id as string, Number(row.id));
      if (row.inserted) report.sessionsInserted++;
    }
  }
  return ids;
}

const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/**
 * A single INSERT .. ON CONFLICT cannot touch one key twice, so repeated keys in a batch are merged first with
 * the same rule the upsert applies across batches: the largest counter wins, the earliest time wins.
 */
export function mergeDuplicateEvents(events: UsageRecord[]): UsageRecord[] {
  const merged = new Map<string, UsageRecord>();
  for (const event of events) {
    const kept = merged.get(event.externalId);
    if (!kept) {
      merged.set(event.externalId, { ...event });
      continue;
    }
    kept.inputTokens = maxOf(kept.inputTokens, event.inputTokens);
    kept.cacheReadTokens = maxOf(kept.cacheReadTokens, event.cacheReadTokens);
    kept.cacheWriteTokens = maxOf(kept.cacheWriteTokens, event.cacheWriteTokens);
    kept.outputTokens = maxOf(kept.outputTokens, event.outputTokens);
    kept.reasoningTokens = maxOf(kept.reasoningTokens, event.reasoningTokens);
    kept.model ??= event.model;
    if (event.occurredAt < kept.occurredAt) kept.occurredAt = event.occurredAt;
  }
  return [...merged.values()];
}

/**
 * Store activity items once per tool (the first file to report an item owns it), then return this file's exact
 * counters: everything it owns, however many times it has been read.
 */
async function storeActivity(
  client: pg.PoolClient,
  toolId: number,
  key: string,
  items: ActivityItem[],
  sessionIds: Map<string, number>,
  batchSize: number,
): Promise<SourceCounters> {
  for (const batch of chunks(items, batchSize)) {
    await client.query(
      `insert into ai_usage.activity_items (tool_id, source_key, kind, external_id, session_id, duration_ms)
       select $1, $2, * from unnest($3::text[], $4::text[], $5::bigint[], $6::bigint[])
       on conflict (tool_id, kind, external_id) do nothing`,
      [
        toolId,
        key,
        batch.map((i) => i.kind),
        batch.map((i) => i.externalId),
        batch.map((i) => (i.sessionExternalId === null ? null : (sessionIds.get(i.sessionExternalId) ?? null))),
        batch.map((i) => i.durationMs),
      ],
    );
  }
  const totals = await client.query(
    `select count(*) filter (where kind = 'prompt') as prompts,
            count(*) filter (where kind = 'tool_call') as tool_calls,
            coalesce(sum(duration_ms) filter (where kind = 'turn'), 0) as duration_ms
     from ai_usage.activity_items where tool_id = $1 and source_key = $2`,
    [toolId, key],
  );
  const row = totals.rows[0];
  return { messageCount: Number(row.prompts), toolCallCount: Number(row.tool_calls), durationMs: Number(row.duration_ms) };
}

/**
 * Upsert by the natural key. On conflict every counter keeps the larger value: a message that was still
 * streaming when it was first read grows, and nothing a later partial read reports can lower it.
 */
async function upsertEvents(
  client: pg.PoolClient,
  toolId: number,
  sessionIds: Map<string, number>,
  events: UsageRecord[],
  batchSize: number,
  report: IngestReport,
): Promise<void> {
  for (const batch of chunks(events, batchSize)) {
    const result = await client.query(
      `insert into ai_usage.usage_events
         (tool_id, session_id, external_id, occurred_at, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens)
       select $1, * from unnest($2::bigint[], $3::text[], $4::timestamptz[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[])
       on conflict (tool_id, external_id) do update set
         occurred_at = least(usage_events.occurred_at, excluded.occurred_at),
         model = coalesce(usage_events.model, excluded.model),
         input_tokens = greatest(usage_events.input_tokens, excluded.input_tokens),
         cache_read_tokens = greatest(usage_events.cache_read_tokens, excluded.cache_read_tokens),
         cache_write_tokens = greatest(usage_events.cache_write_tokens, excluded.cache_write_tokens),
         output_tokens = greatest(usage_events.output_tokens, excluded.output_tokens),
         reasoning_tokens = greatest(usage_events.reasoning_tokens, excluded.reasoning_tokens)
       returning (xmax = 0) as inserted, total_tokens`,
      [
        toolId,
        batch.map((e) => {
          const id = sessionIds.get(e.sessionExternalId);
          if (id === undefined) throw new Error(`usage event "${e.externalId}" refers to a session the collector did not report`);
          return id;
        }),
        batch.map((e) => e.externalId),
        batch.map((e) => e.occurredAt.toISOString()),
        batch.map((e) => e.model),
        batch.map((e) => e.inputTokens),
        batch.map((e) => e.cacheReadTokens),
        batch.map((e) => e.cacheWriteTokens),
        batch.map((e) => e.outputTokens),
        batch.map((e) => e.reasoningTokens),
      ],
    );
    for (const row of result.rows) {
      if (!row.inserted) continue;
      report.eventsInserted++;
      report.tokensInserted += Number(row.total_tokens);
    }
  }
}

async function saveState(
  client: pg.PoolClient,
  toolId: number,
  key: string,
  file: SourceFile,
  parsed: ParseResult,
  sessionIds: Map<string, number>,
  previous: StateRow | undefined,
  exact?: SourceCounters,
): Promise<void> {
  const sessionId = parsed.sessionExternalId ? (sessionIds.get(parsed.sessionExternalId) ?? null) : null;
  await client.query(
    `insert into ai_usage.ingest_state
       (tool_id, source_key, size_bytes, mtime_ms, byte_offset, session_id, message_count, tool_call_count, duration_ms, parser_state, updated_at)
     values ($1, $2, $3, $4, $5, coalesce($6::bigint, $11::bigint), $7, $8, $9, $10, now())
     on conflict (tool_id, source_key) do update set
       size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms, byte_offset = excluded.byte_offset,
       session_id = excluded.session_id, message_count = excluded.message_count, tool_call_count = excluded.tool_call_count,
       duration_ms = excluded.duration_ms, parser_state = excluded.parser_state, updated_at = excluded.updated_at`,
    [
      toolId,
      key,
      file.size,
      file.mtimeMs,
      parsed.offset,
      sessionId,
      // Exact counters (recomputed from stored activity) replace the running totals; otherwise this parse is added.
      exact?.messageCount ?? (previous?.message_count ?? 0) + parsed.counters.messageCount,
      exact?.toolCallCount ?? (previous?.tool_call_count ?? 0) + parsed.counters.toolCallCount,
      exact?.durationMs ?? Number(previous?.duration_ms ?? 0) + parsed.counters.durationMs,
      JSON.stringify(parsed.state),
      previous?.session_id ?? null,
    ],
  );
}
