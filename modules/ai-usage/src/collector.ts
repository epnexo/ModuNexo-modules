/**
 * Collector contract: how a tool's local logs become normalized, metadata-only records.
 *
 * Privacy rule for every implementation: a record may carry timestamps, ids, model names, token counters,
 * counts, durations and a project label (a directory basename). Prompt text, responses, tool inputs and
 * outputs, and full paths never leave the parser.
 *
 * Counter conventions shared by all tools (a counter the tool does not report is `null`, never 0):
 * - `inputTokens`: fresh input, excluding cache reads and cache writes.
 * - `cacheReadTokens` / `cacheWriteTokens`: tokens served from / written to the prompt cache.
 * - `outputTokens`: all generated tokens, including reasoning.
 * - `reasoningTokens`: the reasoning part of `outputTokens`, informational only (not added to totals).
 */

/** A log file found by a collector. */
export interface SourceFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SessionRecord {
  /** The tool's own session id; unique per tool. */
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  /** Basename of the project directory. */
  projectLabel: string | null;
}

export interface UsageRecord {
  /** Natural key, unique per tool. Re-ingesting the same log yields the same key, which makes ingestion idempotent. */
  externalId: string;
  sessionExternalId: string;
  occurredAt: Date;
  model: string | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

/** Activity counters found in the part of a file that was just parsed. They are added to the file's running totals. */
export interface SourceCounters {
  /** Prompts typed by the user. */
  messageCount: number;
  toolCallCount: number;
  durationMs: number;
}

export type ActivityKind = "prompt" | "tool_call" | "turn";

/**
 * One prompt, tool call or finished turn, identified by the tool's own id. Ingestion stores each item once per
 * tool, so a log that repeats earlier lines in another file (resumed sessions, subagent logs) is not counted twice.
 */
export interface ActivityItem {
  kind: ActivityKind;
  externalId: string;
  /** The session the item belongs to, as reported in `sessions`; null when the log does not say. */
  sessionExternalId: string | null;
  /** Only meaningful for `turn`; 0 otherwise. */
  durationMs: number;
  /** For a `tool_call`: the tool's name, for example `Bash`. Null or absent when the log does not say. */
  name?: string | null;
  /** For a `tool_call` that loaded a skill: the skill's name only, never a path or its arguments. */
  skill?: string | null;
  /** True when the log says the call failed, false when it says it worked, null or absent when it does not say. */
  failed?: boolean | null;
}

/** What a tool or skill name may look like. It cannot hold a path separator or a space, so a path or a sentence never fits. */
export const NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,99}$/;

/** Where to continue reading a file: a byte offset and opaque parser state returned by the previous parse. */
export interface ResumePoint {
  offset: number;
  state: unknown;
}

export interface ParseResult {
  sessions: SessionRecord[];
  usage: UsageRecord[];
  /** Activity found in this parse, summed. Used as is by collectors that do not report `activity`. */
  counters: SourceCounters;
  /**
   * Activity items found in this parse. When present, ingestion deduplicates them across files and recomputes the
   * file's counters from the stored items, and `counters` is only informational. Omit it for formats whose
   * activity cannot repeat across files.
   */
  activity?: ActivityItem[];
  /** The session this file belongs to, or null when none was found yet. */
  sessionExternalId: string | null;
  /** Byte offset after the last complete line that was consumed. */
  offset: number;
  state: unknown;
}

export interface Collector {
  /** Stable slug stored in `ai_usage.tools.slug`. */
  readonly toolId: string;
  readonly toolName: string;
  /** Log files currently present, in a stable order. */
  discover(): Promise<SourceFile[]>;
  /** Parse the file from `from`, consuming complete lines only, so a file still being written is safe to read. */
  parse(file: SourceFile, from: ResumePoint): Promise<ParseResult>;
}
