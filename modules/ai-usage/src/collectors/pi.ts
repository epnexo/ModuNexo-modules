import { relative, sep } from "node:path";
import type { ActivityItem, Collector, ParseResult, ResumePoint, SessionRecord, SourceFile, UsageRecord } from "../collector.ts";
import { asRecord, asString, cleanName, counter, findFiles, parseDate, parseObject, projectLabel, readCompleteLines, skillFromArguments } from "./shared.ts";

export interface PiOptions {
  /** Directory with the session logs, normally `~/.pi/agent/sessions`. */
  root: string;
}

/** What must survive between two reads of the same session file. */
interface PiState {
  /** The id in this file's own `session` header; part of every key so keys never collide across files. */
  fileSessionId: string | null;
  projectLabel: string | null;
  startedAt: string | null;
  model: string | null;
}

const EMPTY_STATE: PiState = { fileSessionId: null, projectLabel: null, startedAt: null, model: null };

/**
 * Pi coding agent session logs: `<root>/<project>/<timestamp>_<session id>.jsonl`, plus the runs of subagents at
 * `<root>/<project>/<timestamp>_<session id>/<run>/run-N/session.jsonl`. Every line is one JSON entry.
 *
 * Fields read: the `session` header (`id`, `cwd` basename only), `model_change.modelId`, and for `message`
 * entries only `message.role`, `message.model`, `message.usage` (input, output, cacheRead, cacheWrite,
 * reasoning) and the ids of `toolCall` content blocks. Message text, thinking, tool arguments and results are
 * never read into a record.
 *
 * Events: one per assistant message, keyed `<file session id>:<entry id>`. Pi's `input` already excludes cache
 * reads and writes, and `reasoning` (when reported) is a part of `output`, so counters map one to one. A message
 * without a `usage` object is kept with null counters (unknown); one whose reported usage is all zero used
 * nothing (a failed or aborted request) and is not an event.
 *
 * Sessions: a subagent run is attributed to the session that spawned it (the id in its parent directory name),
 * like Claude Code subagents, and the task handed to a subagent is not counted as a prompt.
 *
 * Idempotency: the files are append-only, so reading resumes at the last complete line; the event key is stable
 * and the database upserts by it. Pi does not log turn durations, so durations are 0.
 */
export function createPiCollector(options: PiOptions): Collector {
  return {
    toolId: "pi",
    toolName: "Pi",
    discover: () => findFiles(options.root, (name) => name.endsWith(".jsonl")),
    parse: (file, from) => parsePiFile(options.root, file, from),
  };
}

/** The session this file belongs to for reporting: its own id, or the parent session's id for a subagent run. */
function reportedSessionId(root: string, file: SourceFile, ownId: string): string {
  const parts = relative(root, file.path).split(sep);
  // <project>/<timestamp>_<session id>/<run>/run-N/session.jsonl
  if (parts.length > 2) {
    const parent = parts[1]!.split("_").slice(1).join("_");
    if (parent) return parent;
  }
  return ownId;
}

async function parsePiFile(root: string, file: SourceFile, from: ResumePoint): Promise<ParseResult> {
  const { lines, offset } = await readCompleteLines(file.path, from.offset);
  const state: PiState = { ...EMPTY_STATE, ...(asRecord(from.state) as Partial<PiState> | undefined) };
  const isSubagent = relative(root, file.path).split(sep).length > 2;
  const usage: UsageRecord[] = [];
  const activity = new Map<string, ActivityItem>();
  const counters = { messageCount: 0, toolCallCount: 0, durationMs: 0 };
  let startedAt = state.startedAt ? new Date(state.startedAt) : undefined;
  let endedAt: Date | undefined;
  let reported: string | null = null;
  const reportedId = () => (state.fileSessionId === null ? null : (reported ??= reportedSessionId(root, file, state.fileSessionId)));

  const addActivity = (kind: ActivityItem["kind"], externalId: string, extra: Partial<ActivityItem> = {}) => {
    const key = `${kind}:${externalId}`;
    if (activity.has(key)) return;
    activity.set(key, { kind, externalId, sessionExternalId: reportedId(), durationMs: 0, ...extra });
    if (kind === "prompt") counters.messageCount++;
    else counters.toolCallCount++;
  };

  for (const line of lines) {
    const entry = parseObject(line);
    if (!entry) continue;
    const timestamp = parseDate(entry.timestamp);

    if (entry.type === "session") {
      if (state.fileSessionId === null) {
        state.fileSessionId = asString(entry.id) ?? null;
        state.projectLabel = projectLabel(entry.cwd);
        startedAt = timestamp ?? startedAt;
        state.startedAt = startedAt?.toISOString() ?? null;
      }
      continue;
    }
    if (timestamp) {
      startedAt ??= timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }
    if (state.fileSessionId === null) continue;

    if (entry.type === "model_change") {
      state.model = asString(entry.modelId) ?? state.model;
      continue;
    }
    const message = entry.type === "message" ? asRecord(entry.message) : undefined;
    const entryId = asString(entry.id);
    if (!message || !entryId) continue;

    if (message.role === "user") {
      if (!isSubagent) addActivity("prompt", `${state.fileSessionId}:${entryId}`);
    } else if (message.role === "toolResult") {
      const callId = asString(message.toolCallId);
      if (callId !== undefined && typeof message.isError === "boolean") {
        const key = `tool_call:${state.fileSessionId}:${callId}`;
        const known = activity.get(key);
        // A result whose call was read earlier is stored only to fill in `failed`; it is not counted again.
        if (known) known.failed = message.isError;
        else activity.set(key, { kind: "tool_call", externalId: `${state.fileSessionId}:${callId}`, sessionExternalId: reportedId(), durationMs: 0, name: null, skill: null, failed: message.isError });
      }
    } else if (message.role === "assistant") {
      if (Array.isArray(message.content)) {
        for (const [index, block] of message.content.entries()) {
          const item = asRecord(block);
          if (item?.type !== "toolCall") continue;
          addActivity("tool_call", `${state.fileSessionId}:${asString(item.id) ?? `${entryId}#${index}`}`, {
            name: cleanName(item.name),
            skill: skillFromArguments(item.arguments),
            failed: null,
          });
        }
      }
      const record = toUsage(state, entryId, timestamp, message, reportedId());
      if (record) usage.push(record);
    }
  }

  const id = reportedId();
  const sessions: SessionRecord[] = id !== null && startedAt ? [{ externalId: id, startedAt, endedAt: endedAt ?? startedAt, projectLabel: state.projectLabel }] : [];
  return { sessions, usage, counters, activity: [...activity.values()], sessionExternalId: id, offset, state };
}

function toUsage(state: PiState, entryId: string, timestamp: Date | undefined, message: Record<string, unknown>, sessionId: string | null): UsageRecord | null {
  if (!timestamp || sessionId === null) return null;
  const usage = asRecord(message.usage);
  const record: UsageRecord = {
    externalId: `${state.fileSessionId}:${entryId}`,
    sessionExternalId: sessionId,
    occurredAt: timestamp,
    model: asString(message.model) ?? state.model,
    inputTokens: counter(usage?.input),
    cacheReadTokens: counter(usage?.cacheRead),
    cacheWriteTokens: counter(usage?.cacheWrite),
    outputTokens: counter(usage?.output),
    reasoningTokens: counter(usage?.reasoning),
  };
  if (usage === undefined) return record;
  const reported = [record.inputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.outputTokens];
  // Every counter reported and all zero: nothing was consumed.
  return reported.every((value) => value === 0) ? null : record;
}
