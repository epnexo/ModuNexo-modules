import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { ActivityItem, Collector, ParseResult, ResumePoint, SessionRecord, SourceFile, UsageRecord } from "../collector.ts";
import { asRecord, asString, counter, projectLabel } from "./shared.ts";

export interface OpenCodeOptions {
  /** Directory with `opencode.db`, normally `~/.local/share/opencode`. */
  root: string;
}

/** The change marks (`time_updated`, epoch ms) of the newest rows read so far. */
interface OpenCodeState {
  messages: number;
  parts: number;
}

const DB_NAME = "opencode.db";
const BUSY_TIMEOUT_MS = 2000;
const MAX_SESSION_DEPTH = 32;

/**
 * OpenCode keeps everything in one SQLite database, `<root>/opencode.db` (WAL mode), not in log files.
 * It is opened read-only with Node's built-in `node:sqlite`, so no dependency is added and nothing is written.
 *
 * Fields read, selected one by one with `json_extract` so no text column reaches the process: `session`
 * (`id`, `parent_id`, `directory` basename only, times); `message` (`id`, `session_id`, times, and from its JSON
 * `role`, `modelID`, `time.created`, `tokens`); `part` (`id`, `session_id`, times, and only whether `type` is
 * `tool`). Message text, tool input and output, titles and paths are never selected.
 *
 * Events: one per assistant message, keyed by its message id. OpenCode reports reasoning separately from
 * `output`, so `outputTokens` is output plus reasoning (matching the log's own `total`) and `reasoningTokens` is
 * the reasoning part. The model is `modelID` as logged; the provider is not stored. A message without `tokens`
 * is kept with null counters; one whose tokens are all zero used nothing and is not an event.
 *
 * Sessions: a child session (a subagent) is attributed to its root session, and the task handed to it is not
 * counted as a prompt. Durations are 0: the database has no turn duration.
 *
 * Idempotency: there is no byte offset in a database. Progress is the highest `time_updated` seen per table; the
 * next run re-reads rows changed at or after it (a streaming message is rewritten, so it comes back with larger
 * counters). Events upsert by message id and activity items dedupe by message or part id, so re-reading a row is
 * harmless. The source's size and mtime include the WAL file, because recent writes live there.
 */
export function createOpenCodeCollector(options: OpenCodeOptions): Collector {
  const dbPath = join(options.root, DB_NAME);
  return {
    toolId: "opencode",
    toolName: "OpenCode",
    discover: () => discoverDatabase(dbPath),
    parse: (file, from) => parseDatabase(file, from),
  };
}

async function discoverDatabase(dbPath: string): Promise<SourceFile[]> {
  const main = await statOrUndefined(dbPath);
  if (!main) return [];
  const wal = await statOrUndefined(`${dbPath}-wal`);
  return [{ path: dbPath, size: main.size + (wal?.size ?? 0), mtimeMs: Math.trunc(Math.max(main.mtimeMs, wal?.mtimeMs ?? 0)) }];
}

async function statOrUndefined(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  role: string | null;
  model: string | null;
  created: number | null;
  tokens: string | null;
}

interface PartRow {
  id: string;
  session_id: string;
  time_updated: number;
}

async function parseDatabase(file: SourceFile, from: ResumePoint): Promise<ParseResult> {
  const previous = asRecord(from.state) as Partial<OpenCodeState> | undefined;
  const state: OpenCodeState = { messages: previous?.messages ?? 0, parts: previous?.parts ?? 0 };
  const db = new DatabaseSync(file.path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const sessionRows = db.prepare("select id, parent_id, directory, time_created, time_updated from session").all() as unknown as SessionRow[];
    const byId = new Map(sessionRows.map((row) => [row.id, row]));
    const rootOf = (id: string): SessionRow | undefined => {
      let row = byId.get(id);
      for (let depth = 0; row?.parent_id && depth < MAX_SESSION_DEPTH; depth++) row = byId.get(row.parent_id) ?? row;
      return row;
    };

    const messages = db
      .prepare(
        `select id, session_id, time_created, time_updated,
                json_extract(data, '$.role') as role,
                json_extract(data, '$.modelID') as model,
                json_extract(data, '$.time.created') as created,
                json_extract(data, '$.tokens') as tokens
         from message where time_updated >= ? order by time_updated, id`,
      )
      .all(state.messages) as unknown as MessageRow[];
    const toolParts = db
      .prepare("select id, session_id, time_updated from part where time_updated >= ? and json_extract(data, '$.type') = 'tool' order by time_updated, id")
      .all(state.parts) as unknown as PartRow[];
    const newestPart = db.prepare("select coalesce(max(time_updated), 0) as newest from part where time_updated >= ?").get(state.parts) as { newest: number };

    const usage: UsageRecord[] = [];
    const activity = new Map<string, ActivityItem>();
    const counters = { messageCount: 0, toolCallCount: 0, durationMs: 0 };
    const touched = new Set<string>();
    const addActivity = (kind: ActivityItem["kind"], externalId: string, sessionExternalId: string) => {
      const key = `${kind}:${externalId}`;
      if (activity.has(key)) return;
      activity.set(key, { kind, externalId, sessionExternalId, durationMs: 0 });
      if (kind === "prompt") counters.messageCount++;
      else counters.toolCallCount++;
    };

    for (const row of messages) {
      state.messages = Math.max(state.messages, row.time_updated);
      const root = rootOf(row.session_id);
      if (!root) continue;
      touched.add(root.id);
      if (row.role === "user") {
        if (!byId.get(row.session_id)?.parent_id) addActivity("prompt", row.id, root.id);
      } else if (row.role === "assistant") {
        const record = toUsage(row, root.id);
        if (record) usage.push(record);
      }
    }
    for (const row of toolParts) {
      const root = rootOf(row.session_id);
      if (!root) continue;
      touched.add(root.id);
      addActivity("tool_call", row.id, root.id);
    }
    state.parts = Math.max(state.parts, newestPart.newest);

    const sessions: SessionRecord[] = [];
    for (const id of touched) {
      const root = byId.get(id)!;
      const members = sessionRows.filter((row) => rootOf(row.id)?.id === id);
      sessions.push({
        externalId: id,
        startedAt: new Date(Math.min(...members.map((m) => m.time_created))),
        endedAt: new Date(Math.max(...members.map((m) => m.time_updated))),
        projectLabel: projectLabel(root.directory),
      });
    }
    // One database holds many sessions, so no single one belongs to the source.
    return { sessions, usage, counters, activity: [...activity.values()], sessionExternalId: null, offset: 0, state };
  } finally {
    db.close();
  }
}

function toUsage(row: MessageRow, sessionId: string): UsageRecord | null {
  const tokens = parseTokens(row.tokens);
  const created = row.created ?? row.time_created;
  const reasoning = counter(tokens?.reasoning);
  const output = counter(tokens?.output);
  const cache = asRecord(tokens?.cache);
  const record: UsageRecord = {
    externalId: row.id,
    sessionExternalId: sessionId,
    occurredAt: new Date(created),
    model: asString(row.model) ?? null,
    inputTokens: counter(tokens?.input),
    cacheReadTokens: counter(cache?.read),
    cacheWriteTokens: counter(cache?.write),
    // OpenCode reports reasoning apart from output; the convention here is that output includes it.
    outputTokens: output === null && reasoning === null ? null : (output ?? 0) + (reasoning ?? 0),
    reasoningTokens: reasoning,
  };
  if (tokens === undefined) return record;
  const reported = [record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens];
  return reported.every((value) => value === 0) ? null : record;
}

function parseTokens(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return undefined;
  }
}
