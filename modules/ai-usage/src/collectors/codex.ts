import type { ActivityItem, Collector, ParseResult, ResumePoint, SessionRecord, SourceFile, UsageRecord } from "../collector.ts";
import { asRecord, asString, cleanName, counter, findFiles, parseDate, parseObject, projectLabel, readCompleteLines, skillFromArguments } from "./shared.ts";

export interface CodexOptions {
  /** Directory with the rollout logs, normally `~/.codex/sessions`. */
  root: string;
}

/** What must survive between two reads of the same rollout file. */
interface CodexState {
  sessionId: string | null;
  projectLabel: string | null;
  startedAt: string | null;
  model: string | null;
  /** `total_token_usage.total_tokens` of the last event that was emitted. */
  lastCumulative: number | null;
}

const EMPTY_STATE: CodexState = { sessionId: null, projectLabel: null, startedAt: null, model: null, lastCumulative: null };

/**
 * Codex rollout logs: `<root>/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Fields read: `session_meta` (`id`, `cwd` basename, only the first one in a file), `turn_context.model`,
 * `event_msg` of type `token_count` (`info.total_token_usage.total_tokens` and `info.last_token_usage.*`),
 * `user_message` and `task_complete` (`turn_id`, `duration_ms`), and `response_item` types
 * `function_call` / `custom_tool_call` (`call_id`, `name`; the arguments are searched for a `skills/<name>/SKILL.md`
 * path to name the skill, and nothing else of them is kept). Codex has no skill event and no per-call error flag,
 * so a skill is an inference and `failed` stays null.
 *
 * Activity: prompts, tool calls and turns are reported as items, so ingestion counts each once per tool.
 *
 * Deduplication: Codex re-emits the same `token_count` several times with an unchanged cumulative total, and
 * a forked rollout carries the parent's cumulative total as its starting point. Only a `token_count` whose
 * cumulative total differs from the previous emitted one counts, and its per-turn `last_token_usage` is the
 * usage added. The event key is `<session id>:<cumulative total>`, strictly increasing within a session.
 */
export function createCodexCollector(options: CodexOptions): Collector {
  return {
    toolId: "codex",
    toolName: "Codex",
    discover: () => findFiles(options.root, (name) => /^rollout-.*\.jsonl$/.test(name)),
    parse: (file, from) => parseCodexFile(file, from),
  };
}

async function parseCodexFile(file: SourceFile, from: ResumePoint): Promise<ParseResult> {
  const { lines, offset } = await readCompleteLines(file.path, from.offset);
  const state: CodexState = { ...EMPTY_STATE, ...(asRecord(from.state) as Partial<CodexState> | undefined) };
  const usage: UsageRecord[] = [];
  const counters = { messageCount: 0, toolCallCount: 0, durationMs: 0 };
  const activity = new Map<string, ActivityItem>();
  const addActivity = (kind: ActivityItem["kind"], externalId: string, durationMs = 0, extra: Partial<ActivityItem> = {}) => {
    const key = `${kind}:${externalId}`;
    if (!activity.has(key)) activity.set(key, { kind, externalId, sessionExternalId: state.sessionId, durationMs, ...extra });
  };
  const stamp = (entry: Record<string, unknown>) => `${state.sessionId ?? ""}:${asString(entry.timestamp) ?? ""}`;
  let startedAt = state.startedAt ? new Date(state.startedAt) : undefined;
  let endedAt: Date | undefined;

  for (const line of lines) {
    const entry = parseObject(line);
    if (!entry) continue;
    const timestamp = parseDate(entry.timestamp);
    const payload = asRecord(entry.payload);

    if (entry.type === "session_meta" && payload) {
      // A forked rollout repeats its ancestors' metadata later in the file; only the first one is this file's.
      if (state.sessionId === null) {
        state.sessionId = asString(payload.id) ?? null;
        state.projectLabel = projectLabel(payload.cwd);
        startedAt = parseDate(payload.timestamp) ?? timestamp;
        state.startedAt = startedAt?.toISOString() ?? null;
      }
      continue;
    }
    if (timestamp) {
      startedAt ??= timestamp;
      if (!endedAt || timestamp > endedAt) endedAt = timestamp;
    }
    if (!payload) continue;

    if (entry.type === "turn_context") {
      state.model = asString(payload.model) ?? state.model;
    } else if (entry.type === "response_item") {
      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        counters.toolCallCount++;
        addActivity("tool_call", asString(payload.call_id) ?? stamp(entry), 0, {
          name: cleanName(payload.name),
          skill: skillFromArguments(payload.arguments ?? payload.input),
          failed: null,
        });
      }
    } else if (entry.type === "event_msg") {
      if (payload.type === "user_message") {
        counters.messageCount++;
        addActivity("prompt", stamp(entry));
      } else if (payload.type === "task_complete") {
        counters.durationMs += counter(payload.duration_ms) ?? 0;
        addActivity("turn", asString(payload.turn_id) ?? stamp(entry), counter(payload.duration_ms) ?? 0);
      }
      else if (payload.type === "token_count" && state.sessionId !== null && timestamp) {
        const info = asRecord(payload.info);
        const cumulative = counter(asRecord(info?.total_token_usage)?.total_tokens);
        const last = asRecord(info?.last_token_usage);
        if (cumulative === null || !last || cumulative === state.lastCumulative) continue;
        state.lastCumulative = cumulative;

        const input = counter(last.input_tokens);
        const cached = counter(last.cached_input_tokens);
        const output = counter(last.output_tokens);
        // Some token_count lines carry only a grand total with an all-zero breakdown. The breakdown is
        // unknown there, so it is stored as null rather than as zeros.
        const breakdownMissing = (counter(last.total_tokens) ?? 0) > 0 && (input ?? 0) + (output ?? 0) === 0;
        usage.push({
          externalId: `${state.sessionId}:${cumulative}`,
          sessionExternalId: state.sessionId,
          occurredAt: timestamp,
          model: state.model,
          // Codex reports cached tokens inside input_tokens; normalize to fresh input.
          inputTokens: breakdownMissing || input === null ? null : Math.max(input - (cached ?? 0), 0),
          cacheReadTokens: breakdownMissing ? null : cached,
          cacheWriteTokens: breakdownMissing ? null : counter(last.cache_write_input_tokens),
          outputTokens: breakdownMissing ? null : output,
          reasoningTokens: breakdownMissing ? null : counter(last.reasoning_output_tokens),
        });
      }
    }
  }

  const sessions: SessionRecord[] =
    state.sessionId !== null && startedAt
      ? [{ externalId: state.sessionId, startedAt, endedAt: endedAt ?? startedAt, projectLabel: state.projectLabel }]
      : [];
  return { sessions, usage, counters, activity: [...activity.values()], sessionExternalId: state.sessionId, offset, state };
}
