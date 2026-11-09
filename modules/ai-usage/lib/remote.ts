import { getDb } from "@modunexo/sdk";
import { NAME_PATTERN, type ActivityItem, type ActivityKind, type SessionRecord, type UsageRecord } from "../src/collector.ts";
import { mergeDuplicateEvents, storeActivity, upsertEvents, upsertSessions, type InsertCounts } from "../src/ingest.ts";

export const MAX_BODY_CHARS = 2_000_000;
export const MAX_ITEMS = 2000;
const MAX_COUNTER = 1_000_000_000_000_000;
const ACTIVITY_SOURCE = "remote";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export interface RemoteBatch {
  tool: { slug: string; name: string };
  sessions: SessionRecord[];
  usage: UsageRecord[];
  activity: ActivityItem[];
}

export interface RemoteReport extends InsertCounts {
  activityReceived: number;
}

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Postgres cannot store a NUL in text, so it is refused here as a bad request instead of failing the write. */
function text(raw: unknown, where: string, max: number, nullable = false): Checked<string | null> {
  if (raw === null || raw === undefined) return nullable ? { ok: true, value: null } : bad(`${where} is required.`);
  if (typeof raw !== "string" || raw.includes("\u0000") || raw.trim() === "" || raw.length > max) return bad(`${where} must be a text of 1 to ${max} characters.`);
  return { ok: true, value: raw };
}

function time(raw: unknown, where: string): Checked<Date> {
  const value = typeof raw === "string" ? new Date(raw) : undefined;
  if (value === undefined || Number.isNaN(value.getTime())) return bad(`${where} must be an ISO 8601 date and time.`);
  return { ok: true, value };
}

function counter(raw: unknown, where: string, nullable: boolean): Checked<number | null> {
  if (raw === null || raw === undefined) return nullable ? { ok: true, value: null } : bad(`${where} is required.`);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_COUNTER) return bad(`${where} must be a whole number of at least 0.`);
  return { ok: true, value: raw };
}

/** A tool or skill name: optional, and it cannot be a path or a sentence. */
function shortName(raw: unknown, where: string): Checked<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || !NAME_PATTERN.test(raw)) return bad(`${where} must be a name of 1 to 100 letters, digits and . _ : @ -.`);
  return { ok: true, value: raw };
}

function flag(raw: unknown, where: string): Checked<boolean | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "boolean") return bad(`${where} must be true or false.`);
  return { ok: true, value: raw };
}

function list(raw: unknown, where: string): Checked<unknown[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return bad(`${where} must be a list.`);
  if (raw.length > MAX_ITEMS) return bad(`${where} holds at most ${MAX_ITEMS} entries per request.`);
  return { ok: true, value: raw };
}

const ACTIVITY_KINDS: ActivityKind[] = ["prompt", "tool_call", "turn"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Checks what a collector posts. The error names the first field that cannot be used. */
export function batchInput(body: Record<string, unknown>): Checked<RemoteBatch> {
  if (!isObject(body.tool)) return bad("tool is required.");
  const slug = text(body.tool.slug, "tool.slug", 32);
  if (!slug.ok) return slug;
  if (!SLUG.test(slug.value!)) return bad("tool.slug must use lowercase letters, digits and hyphens.");
  const name = text(body.tool.name, "tool.name", 64);
  if (!name.ok) return name;

  const rawSessions = list(body.sessions, "sessions");
  if (!rawSessions.ok) return rawSessions;
  const sessions: SessionRecord[] = [];
  for (const [i, item] of rawSessions.value.entries()) {
    const where = `sessions[${i}]`;
    if (!isObject(item)) return bad(`${where} must be an object.`);
    const externalId = text(item.externalId, `${where}.externalId`, 200);
    const startedAt = time(item.startedAt, `${where}.startedAt`);
    const endedAt = time(item.endedAt, `${where}.endedAt`);
    const projectLabel = text(item.projectLabel, `${where}.projectLabel`, 200, true);
    for (const checked of [externalId, startedAt, endedAt, projectLabel]) if (!checked.ok) return checked;
    sessions.push({ externalId: externalId.ok ? externalId.value! : "", startedAt: startedAt.ok ? startedAt.value : new Date(0), endedAt: endedAt.ok ? endedAt.value : new Date(0), projectLabel: projectLabel.ok ? projectLabel.value : null });
  }
  const known = new Set(sessions.map((s) => s.externalId));

  const rawUsage = list(body.usage, "usage");
  if (!rawUsage.ok) return rawUsage;
  const usage: UsageRecord[] = [];
  for (const [i, item] of rawUsage.value.entries()) {
    const where = `usage[${i}]`;
    if (!isObject(item)) return bad(`${where} must be an object.`);
    const externalId = text(item.externalId, `${where}.externalId`, 200);
    const sessionExternalId = text(item.sessionExternalId, `${where}.sessionExternalId`, 200);
    const occurredAt = time(item.occurredAt, `${where}.occurredAt`);
    const model = text(item.model, `${where}.model`, 200, true);
    const counters = (["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"] as const).map((key) => counter(item[key], `${where}.${key}`, true));
    for (const checked of [externalId, sessionExternalId, occurredAt, model, ...counters]) if (!checked.ok) return checked;
    if (!known.has(sessionExternalId.ok ? sessionExternalId.value! : "")) return bad(`${where}.sessionExternalId must be one of the sessions in this request.`);
    const [inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens] = counters.map((c) => (c.ok ? c.value : null));
    usage.push({
      externalId: externalId.ok ? externalId.value! : "",
      sessionExternalId: sessionExternalId.ok ? sessionExternalId.value! : "",
      occurredAt: occurredAt.ok ? occurredAt.value : new Date(0),
      model: model.ok ? model.value : null,
      inputTokens: inputTokens ?? null,
      cacheReadTokens: cacheReadTokens ?? null,
      cacheWriteTokens: cacheWriteTokens ?? null,
      outputTokens: outputTokens ?? null,
      reasoningTokens: reasoningTokens ?? null,
    });
  }

  const rawActivity = list(body.activity, "activity");
  if (!rawActivity.ok) return rawActivity;
  const activity: ActivityItem[] = [];
  for (const [i, item] of rawActivity.value.entries()) {
    const where = `activity[${i}]`;
    if (!isObject(item)) return bad(`${where} must be an object.`);
    if (typeof item.kind !== "string" || !ACTIVITY_KINDS.includes(item.kind as ActivityKind)) return bad(`${where}.kind must be one of ${ACTIVITY_KINDS.join(", ")}.`);
    const externalId = text(item.externalId, `${where}.externalId`, 200);
    const sessionExternalId = text(item.sessionExternalId, `${where}.sessionExternalId`, 200, true);
    const durationMs = counter(item.durationMs ?? 0, `${where}.durationMs`, false);
    const toolName = shortName(item.name, `${where}.name`);
    const skill = shortName(item.skill, `${where}.skill`);
    const failed = flag(item.failed, `${where}.failed`);
    for (const checked of [externalId, sessionExternalId, durationMs, toolName, skill, failed]) if (!checked.ok) return checked;
    activity.push({
      kind: item.kind as ActivityKind,
      externalId: externalId.ok ? externalId.value! : "",
      sessionExternalId: sessionExternalId.ok ? sessionExternalId.value : null,
      durationMs: durationMs.ok ? (durationMs.value ?? 0) : 0,
      name: toolName.ok ? toolName.value : null,
      skill: skill.ok ? skill.value : null,
      failed: failed.ok ? failed.value : null,
    });
  }
  return { ok: true, value: { tool: { slug: slug.value!, name: name.value! }, sessions, usage, activity } };
}

/**
 * Stores one batch in a single transaction, with the same upserts the local ingestor uses, so sending the same
 * batch twice, or a batch that overlaps an earlier one, changes nothing the second time.
 */
export async function storeBatch(batch: RemoteBatch): Promise<RemoteReport> {
  const report: RemoteReport = { sessionsInserted: 0, eventsInserted: 0, tokensInserted: 0, activityReceived: batch.activity.length };
  await getDb("ai-usage").transaction(async (tx) => {
    await tx.query("insert into ai_usage.tools (slug, name) values ($1, $2) on conflict (slug) do nothing", [batch.tool.slug, batch.tool.name]);
    const tool = await tx.query("select id from ai_usage.tools where slug = $1", [batch.tool.slug]);
    const toolId = Number(tool.rows[0]!.id);
    const sessionIds = await upsertSessions(tx, toolId, batch.sessions, MAX_ITEMS, report);
    await upsertEvents(tx, toolId, sessionIds, mergeDuplicateEvents(batch.usage), MAX_ITEMS, report);
    await storeActivity(tx, toolId, ACTIVITY_SOURCE, batch.activity, sessionIds, MAX_ITEMS);
    await tx.query(
      "insert into ai_usage.ingest_receipts (tool_id, received_at) values ($1, now()) on conflict (tool_id) do update set received_at = excluded.received_at",
      [toolId],
    );
  });
  return report;
}
