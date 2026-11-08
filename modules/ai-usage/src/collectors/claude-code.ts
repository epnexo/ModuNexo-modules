import type { ActivityItem, Collector, ParseResult, ResumePoint, SessionRecord, SourceFile, UsageRecord } from "../collector.ts";
import { asRecord, asString, counter, findFiles, parseDate, parseObject, projectLabel, readCompleteLines } from "./shared.ts";

export interface ClaudeCodeOptions {
  /** Directory with the session logs, normally `~/.claude/projects`. */
  root: string;
}

const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude Code session logs: `<root>/<project>/<session>.jsonl` plus `<session>/subagents/*.jsonl`.
 *
 * Fields read: `type`, `sessionId`, `cwd` (basename only), `timestamp`, `isSidechain`, `requestId`,
 * `message.id`, `message.model`, `message.usage.*` (input, cache read/creation, output, thinking tokens),
 * the types of `message.content` blocks (never their text), and `system` lines with `subtype: turn_duration`.
 *
 * Activity: prompts (`uuid`), tool calls (`tool_use` id) and turns (`uuid`) are reported as items so ingestion
 * counts each once even when a resumed session repeats it in another file.
 *
 * Deduplication: the API response of one request is written as several lines (one per content block, and
 * again in resumed or subagent logs), each repeating the same usage with `output_tokens` growing while it
 * streams. Lines are grouped by `message.id:requestId` and every counter keeps its largest value, which is the
 * final one. The same key is the database unique key, so repeats across files and runs collapse too.
 */
export function createClaudeCodeCollector(options: ClaudeCodeOptions): Collector {
  return {
    toolId: "claude-code",
    toolName: "Claude Code",
    discover: () => findFiles(options.root, (name) => name.endsWith(".jsonl")),
    parse: (file, from) => parseClaudeFile(file, from),
  };
}

interface Span {
  startedAt: Date;
  endedAt: Date;
  projectLabel: string | null;
}

const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

async function parseClaudeFile(file: SourceFile, from: ResumePoint): Promise<ParseResult> {
  const { lines, offset } = await readCompleteLines(file.path, from.offset);
  const spans = new Map<string, Span>();
  const events = new Map<string, UsageRecord>();
  const activity = new Map<string, ActivityItem>();
  const addActivity = (kind: ActivityItem["kind"], externalId: string, sessionExternalId: string | null, durationMs = 0) => {
    const key = `${kind}:${externalId}`;
    if (!activity.has(key)) activity.set(key, { kind, externalId, sessionExternalId, durationMs });
  };
  const counters = { messageCount: 0, toolCallCount: 0, durationMs: 0 };
  let sessionExternalId: string | null = null;

  for (const line of lines) {
    const entry = parseObject(line);
    if (!entry) continue;
    const sessionId = asString(entry.sessionId);
    const timestamp = parseDate(entry.timestamp);
    if (sessionId) {
      sessionExternalId ??= sessionId;
      if (timestamp) {
        const span = spans.get(sessionId);
        if (!span) spans.set(sessionId, { startedAt: timestamp, endedAt: timestamp, projectLabel: projectLabel(entry.cwd) });
        else {
          if (timestamp < span.startedAt) span.startedAt = timestamp;
          if (timestamp > span.endedAt) span.endedAt = timestamp;
          span.projectLabel ??= projectLabel(entry.cwd);
        }
      }
    }

    const message = asRecord(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];

    if (entry.type === "user" && message && entry.isSidechain !== true && entry.isMeta !== true) {
      const isToolResult = entry.toolUseResult !== undefined || entry.sourceToolAssistantUUID !== undefined || content.some((block) => asRecord(block)?.type === "tool_result");
      if (!isToolResult) addActivity("prompt", asString(entry.uuid) ?? `${sessionId}:${asString(entry.timestamp)}`, sessionId ?? null);
    } else if (entry.type === "system" && entry.subtype === "turn_duration") {
      addActivity("turn", asString(entry.uuid) ?? `${sessionId}:${asString(entry.timestamp)}`, sessionId ?? null, counter(entry.durationMs) ?? 0);
    } else if (entry.type === "assistant" && message) {
      content.forEach((block, index) => {
        const item = asRecord(block);
        if (item?.type !== "tool_use") return;
        // Without a tool_use id, the message id and block position still identify the call.
        addActivity("tool_call", asString(item.id) ?? `${asString(message.id) ?? asString(entry.uuid)}#${index}`, sessionId ?? null);
      });
      const usage = asRecord(message.usage);
      const messageId = asString(message.id);
      const model = asString(message.model);
      if (!usage || !messageId || !sessionId || !timestamp || model === SYNTHETIC_MODEL) continue;

      const requestId = asString(entry.requestId);
      const key = requestId ? `${messageId}:${requestId}` : messageId;
      const next = {
        inputTokens: counter(usage.input_tokens),
        cacheReadTokens: counter(usage.cache_read_input_tokens),
        cacheWriteTokens: counter(usage.cache_creation_input_tokens),
        outputTokens: counter(usage.output_tokens),
        reasoningTokens: counter(asRecord(usage.output_tokens_details)?.thinking_tokens),
      };
      const existing = events.get(key);
      if (!existing) {
        events.set(key, { externalId: key, sessionExternalId: sessionId, occurredAt: timestamp, model: model ?? null, ...next });
      } else {
        existing.inputTokens = maxOf(existing.inputTokens, next.inputTokens);
        existing.cacheReadTokens = maxOf(existing.cacheReadTokens, next.cacheReadTokens);
        existing.cacheWriteTokens = maxOf(existing.cacheWriteTokens, next.cacheWriteTokens);
        existing.outputTokens = maxOf(existing.outputTokens, next.outputTokens);
        existing.reasoningTokens = maxOf(existing.reasoningTokens, next.reasoningTokens);
        existing.model ??= model ?? null;
        if (timestamp < existing.occurredAt) existing.occurredAt = timestamp;
      }
    }
  }

  const items = [...activity.values()];
  for (const item of items) {
    if (item.kind === "prompt") counters.messageCount++;
    else if (item.kind === "tool_call") counters.toolCallCount++;
    else counters.durationMs += item.durationMs;
  }
  const sessions: SessionRecord[] = [...spans].map(([externalId, span]) => ({ externalId, ...span }));
  return { sessions, usage: [...events.values()], counters, activity: items, sessionExternalId, offset, state: null };
}
