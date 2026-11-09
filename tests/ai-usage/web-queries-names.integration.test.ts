import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import type pg from "pg";
import { getHourly, getModelTokens, getProjects, getToolActivity, getTopSkills, getTopTools } from "../../modules/ai-usage/web/queries.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let scratchUrl: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  scratchUrl = scratch.url;
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(aiUsage);
  await migrate(pool, registry, { moduleDirs: { "ai-usage": MODULE_DIR } });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

const q = (sql: string, values: unknown[] = []) => pool!.query(sql, values);

/**
 * Seed (tool calls carry names; skills are exact for claude-code and inferred for codex):
 *  - claude-code session A (2026-10-01 to 02): Skill/alpha x3, Skill/beta x1, Bash x4 (3 ok, 1 failed), one prompt.
 *  - codex session B (2026-10-02): exec_command x2 with skill alpha, apply_patch x1 whose outcome is unknown, two prompts.
 *  - pi session D (2026-09-01, outside a 30 day window from October): read x1 with skill old-skill.
 *  - codex session C: no activity at all.
 */
async function seed(): Promise<void> {
  await q("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions restart identity cascade");
  await q("insert into ai_usage.tools (slug, name) values ('pi', 'Pi') on conflict (slug) do nothing");
  const tool = async (slug: string) => Number((await q("select id from ai_usage.tools where slug = $1", [slug])).rows[0].id);
  const [claude, codex, pi] = [await tool("claude-code"), await tool("codex"), await tool("pi")];
  const session = async (toolId: number, externalId: string, startedAt: string, endedAt: string, label: string | null) =>
    Number((await q("insert into ai_usage.sessions (tool_id, external_id, started_at, ended_at, project_label) values ($1, $2, $3, $4, $5) returning id", [toolId, externalId, startedAt, endedAt, label])).rows[0].id);
  const event = (toolId: number, sessionId: number, key: string, at: string, tokens: number) =>
    q("insert into ai_usage.usage_events (tool_id, session_id, external_id, occurred_at, model, input_tokens) values ($1, $2, $3, $4, 'm1', $5)", [toolId, sessionId, key, at, tokens]);
  let n = 0;
  const item = (toolId: number, sessionId: number | null, kind: string, name: string | null, skill: string | null, failed: boolean | null) =>
    q("insert into ai_usage.activity_items (tool_id, source_key, kind, external_id, session_id, name, skill, failed) values ($1, 'src', $2, $3, $4, $5, $6, $7)", [toolId, kind, `i${++n}`, sessionId, name, skill, failed]);

  const a = await session(claude, "A", "2026-10-01T23:30:00Z", "2026-10-02T00:10:00Z", "demo-app");
  await event(claude, a, "a1", "2026-10-01T23:30:00Z", 100);
  await item(claude, a, "prompt", null, null, null);
  for (let i = 0; i < 3; i++) await item(claude, a, "tool_call", "Skill", "alpha", false);
  await item(claude, a, "tool_call", "Skill", "beta", false);
  for (let i = 0; i < 3; i++) await item(claude, a, "tool_call", "Bash", null, false);
  await item(claude, a, "tool_call", "Bash", null, true);

  const b = await session(codex, "B", "2026-10-02T12:00:00Z", "2026-10-02T12:30:00Z", "demo-cli");
  await event(codex, b, "b1", "2026-10-02T12:00:00Z", 40);
  await item(codex, b, "prompt", null, null, null);
  await item(codex, b, "prompt", null, null, null);
  await item(codex, b, "tool_call", "exec_command", "alpha", null);
  await item(codex, b, "tool_call", "exec_command", "alpha", null);
  await item(codex, b, "tool_call", "apply_patch", null, null);

  await session(codex, "C", "2026-10-03T08:00:00Z", "2026-10-03T08:00:00Z", null);

  const d = await session(pi, "D", "2026-09-01T09:00:00Z", "2026-09-01T09:10:00Z", "demo-pi");
  await event(pi, d, "d1", "2026-09-01T09:00:00Z", 5);
  await item(pi, d, "tool_call", "read", "old-skill", null);
}

beforeEach(async () => {
  if (pool) await seed();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const ALL = { since: null, tool: null };
const OCTOBER = { since: "2026-10-01", tool: null };

describe("web queries for skills, tools and projects (integration)", () => {
  test("getTopSkills ranks skills by calls per tool and counts the sessions that used them", async () => {
    const rows = await getTopSkills(pool!, ALL);
    assert.deepEqual(rows.map((r) => [r.tool, r.skill, r.calls, r.sessions]), [
      ["claude-code", "alpha", 3, 1],
      ["codex", "alpha", 2, 1],
      ["claude-code", "beta", 1, 1],
      ["pi", "old-skill", 1, 1],
    ]);
  });

  test("getTopSkills leaves out calls whose session started before the period and respects the tool filter and the limit", async () => {
    assert.deepEqual((await getTopSkills(pool!, OCTOBER)).map((r) => r.skill), ["alpha", "alpha", "beta"]);
    assert.deepEqual((await getTopSkills(pool!, { since: null, tool: "codex" })).map((r) => [r.tool, r.skill]), [["codex", "alpha"]]);
    assert.equal((await getTopSkills(pool!, ALL, 2)).length, 2);
  });

  test("getTopTools counts calls and failures, and counts only the calls whose outcome the log reports as known", async () => {
    const rows = await getTopTools(pool!, { since: "2026-10-01", tool: null });
    const byName = new Map(rows.map((r) => [`${r.tool}/${r.name}`, r]));
    assert.deepEqual([byName.get("claude-code/Bash")!.calls, byName.get("claude-code/Bash")!.failed, byName.get("claude-code/Bash")!.reported], [4, 1, 4]);
    assert.deepEqual([byName.get("codex/apply_patch")!.calls, byName.get("codex/apply_patch")!.failed, byName.get("codex/apply_patch")!.reported], [1, 0, 0]);
    assert.equal(rows[0]!.name, "Bash", "most used first");
    assert.equal(byName.has("pi/read"), false);
  });

  test("getToolActivity gives prompts, tool calls, failed calls and the last time each tool was active", async () => {
    const rows = await getToolActivity(pool!, OCTOBER);
    const codex = rows.find((r) => r.tool === "codex")!;
    assert.deepEqual([codex.prompts, codex.toolCalls, codex.failedCalls], [2, 3, 0]);
    assert.equal(codex.lastActiveAt?.toISOString(), "2026-10-02T12:30:00.000Z");
    const claude = rows.find((r) => r.tool === "claude-code")!;
    assert.deepEqual([claude.prompts, claude.toolCalls, claude.failedCalls], [1, 8, 1]);
    assert.equal(rows.some((r) => r.tool === "pi"), false);
  });

  test("getProjects ranks the project labels by tokens and keeps sessions without a label apart", async () => {
    const rows = await getProjects(pool!, ALL);
    assert.deepEqual(rows.map((r) => [r.project, r.tool, r.totalTokens, r.sessions]), [
      ["demo-app", "claude-code", 100, 1],
      ["demo-cli", "codex", 40, 1],
      ["demo-pi", "pi", 5, 1],
    ]);
    assert.deepEqual((await getProjects(pool!, { since: null, tool: "pi" })).map((r) => r.project), ["demo-pi"]);
  });

  test("getModelTokens gives every counter per tool and model, with null where nothing was reported", async () => {
    const rows = await getModelTokens(pool!, ALL);
    assert.deepEqual(rows.map((r) => [r.tool, r.model, r.inputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.outputTokens]), [
      ["claude-code", "m1", 100, null, null, null],
      ["codex", "m1", 40, null, null, null],
      ["pi", "m1", 5, null, null, null],
    ]);
    assert.deepEqual((await getModelTokens(pool!, OCTOBER)).map((r) => r.tool), ["claude-code", "codex"]);
  });

  test("getHourly sums tokens by UTC weekday (Monday is 0) and hour, and follows the period and tool filters", async () => {
    const rows = await getHourly(pool!, ALL);
    assert.deepEqual(rows.map((r) => [r.weekday, r.hour, r.totalTokens]), [[1, 9, 5], [3, 23, 100], [4, 12, 40]]);
    assert.deepEqual((await getHourly(pool!, OCTOBER)).map((r) => [r.weekday, r.hour]), [[3, 23], [4, 12]]);
    assert.deepEqual((await getHourly(pool!, { since: null, tool: "codex" })).map((r) => [r.weekday, r.hour, r.totalTokens]), [[4, 12, 40]]);
  });
});
