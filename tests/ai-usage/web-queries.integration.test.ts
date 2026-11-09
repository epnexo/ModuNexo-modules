import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import type pg from "pg";
import { getByModel, getByTool, getDaily, getRecentSessions, getSummary, getTools } from "../../modules/ai-usage/web/queries.ts";

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
 * Seed:
 *  - claude-code session A: events at 2026-10-01 23:30Z and 2026-10-02 00:10Z (crosses a UTC midnight), model m1.
 *    The second event does not report cache writes.
 *  - codex session B: one event on 2026-10-02, model m1 (the same model under a second tool), no cache writes.
 *  - codex session C: no events at all.
 *  - pi session D: one old event (2026-09-01) with no model and no counters reported.
 *  - claude-code session E: two events with two different models.
 */
async function seed(): Promise<void> {
  await q("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions restart identity cascade");
  await q("insert into ai_usage.tools (slug, name) values ('pi', 'Pi') on conflict (slug) do nothing");
  const tool = async (slug: string) => Number((await q("select id from ai_usage.tools where slug = $1", [slug])).rows[0].id);
  const [claude, codex, pi] = [await tool("claude-code"), await tool("codex"), await tool("pi")];

  const session = async (toolId: number, externalId: string, startedAt: string, label: string | null) =>
    Number(
      (
        await q(
          "insert into ai_usage.sessions (tool_id, external_id, started_at, ended_at, project_label) values ($1, $2, $3, $3, $4) returning id",
          [toolId, externalId, startedAt, label],
        )
      ).rows[0].id,
    );
  const event = (
    toolId: number,
    sessionId: number,
    key: string,
    at: string,
    model: string | null,
    counters: [number | null, number | null, number | null, number | null],
  ) =>
    q(
      `insert into ai_usage.usage_events
         (tool_id, session_id, external_id, occurred_at, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [toolId, sessionId, key, at, model, ...counters],
    );

  const a = await session(claude, "A", "2026-10-01T23:30:00Z", "demo-app");
  await event(claude, a, "a1", "2026-10-01T23:30:00Z", "m1", [10, 100, 5, 1]);
  await event(claude, a, "a2", "2026-10-02T00:10:00Z", "m1", [20, 200, null, 2]);

  const b = await session(codex, "B", "2026-10-02T12:00:00Z", "demo-cli");
  await event(codex, b, "b1", "2026-10-02T12:00:00Z", "m1", [7, 70, null, 3]);

  await session(codex, "C", "2026-10-03T08:00:00Z", null);

  const d = await session(pi, "D", "2026-09-01T09:00:00Z", "demo-pi");
  await event(pi, d, "d1", "2026-09-01T09:00:00Z", null, [null, null, null, null]);

  const e = await session(claude, "E", "2026-10-02T15:00:00Z", "demo-app");
  await event(claude, e, "e1", "2026-10-02T15:00:00Z", "m1", [1, 1, 1, 1]);
  await event(claude, e, "e2", "2026-10-02T15:05:00Z", "m2", [2, 2, 2, 2]);
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

describe("web queries (integration)", () => {
  test("getTools lists the registered tools in id order", async () => {
    const tools = await getTools(pool!);
    assert.deepEqual(
      tools.map((t) => t.slug),
      ["claude-code", "codex", "pi"],
    );
    assert.equal(tools[0]!.name, "Claude Code");
  });

  test("getSummary adds up counters and keeps unreported ones null", async () => {
    const all = await getSummary(pool!, ALL);
    assert.equal(all.sessions, 4); // A, B, D and E have events; C has none
    assert.equal(all.activeDays, 3); // 2026-09-01, 2026-10-01, 2026-10-02
    assert.equal(all.inputTokens, 10 + 20 + 7 + 1 + 2);
    assert.equal(all.cacheWriteTokens, 5 + 1 + 2);
    assert.equal(all.totalTokens, 116 + 222 + 80 + 4 + 8);

    const codex = await getSummary(pool!, { since: null, tool: "codex" });
    assert.equal(codex.totalTokens, 80);
    assert.equal(codex.cacheWriteTokens, null);
    assert.equal(codex.outputTokens, 3);
    assert.equal(codex.sessions, 1);
  });

  test("getSummary returns null counters and zero totals for a tool that reports nothing", async () => {
    const pi = await getSummary(pool!, { since: null, tool: "pi" });
    assert.equal(pi.inputTokens, null);
    assert.equal(pi.outputTokens, null);
    assert.equal(pi.totalTokens, 0);
    assert.equal(pi.sessions, 1);
  });

  test("the since filter is a UTC day boundary", async () => {
    const summary = await getSummary(pool!, { since: "2026-10-02", tool: null });
    // The 23:30Z event on 2026-10-01 is excluded, the 00:10Z event on 2026-10-02 is included.
    assert.equal(summary.inputTokens, 20 + 7 + 1 + 2);
    assert.equal(summary.activeDays, 1);
    assert.equal(summary.sessions, 3);
  });

  test("getDaily buckets by UTC day per tool and returns the day as text", async () => {
    const rows = await getDaily(pool!, { since: "2026-10-01", tool: null });
    const claude = rows.filter((r) => r.tool === "claude-code");
    assert.deepEqual(
      claude.map((r) => [r.day, r.totalTokens]),
      [
        ["2026-10-01", 116],
        ["2026-10-02", 222 + 4 + 8],
      ],
    );
    assert.deepEqual(
      rows.filter((r) => r.tool === "codex").map((r) => [r.day, r.totalTokens]),
      [["2026-10-02", 80]],
    );
    assert.equal(rows.some((r) => r.tool === "pi"), false);
  });

  test("getDaily applies the tool filter", async () => {
    const rows = await getDaily(pool!, { since: null, tool: "pi" });
    assert.deepEqual(rows, [{ day: "2026-09-01", tool: "pi", totalTokens: 0 }]);
  });

  test("getByTool reports counters per tool, null where a tool never reports one", async () => {
    const rows = await getByTool(pool!, ALL);
    const byTool = Object.fromEntries(rows.map((r) => [r.tool, r]));
    assert.deepEqual(Object.keys(byTool).sort(), ["claude-code", "codex", "pi"]);
    assert.equal(byTool.codex!.name, "Codex");
    assert.equal(byTool.codex!.cacheWriteTokens, null);
    assert.equal(byTool.codex!.totalTokens, 80);
    assert.equal(byTool["claude-code"]!.sessions, 2);
    assert.equal(byTool["claude-code"]!.activeDays, 2);
    assert.equal(byTool.pi!.inputTokens, null);
    // Sorted by total tokens, largest first.
    assert.equal(rows[0]!.tool, "claude-code");
  });

  test("getByModel keeps one row per model and tool, so a shared model shows under both", async () => {
    const rows = await getByModel(pool!, ALL);
    const m1 = rows.filter((r) => r.model === "m1").map((r) => [r.tool, r.totalTokens]);
    assert.deepEqual(m1.sort(), [
      ["claude-code", 116 + 222 + 4],
      ["codex", 80],
    ]);
    // A missing model stays null instead of becoming a made-up label.
    assert.ok(rows.some((r) => r.model === null && r.tool === "pi"));
  });

  test("getRecentSessions returns newest first, honours filters and limit", async () => {
    const rows = await getRecentSessions(pool!, ALL, 10);
    assert.deepEqual(
      rows.map((r) => r.externalId),
      ["C", "E", "B", "A", "D"],
    );

    const codexOnly = await getRecentSessions(pool!, { since: null, tool: "codex" }, 10);
    assert.deepEqual(codexOnly.map((r) => r.externalId), ["C", "B"]);

    const recent = await getRecentSessions(pool!, { since: "2026-10-02", tool: null }, 2);
    assert.deepEqual(recent.map((r) => r.externalId), ["C", "E"]);
  });

  test("getRecentSessions sets model only when it is single, and exposes events so empty sessions are detectable", async () => {
    const rows = Object.fromEntries((await getRecentSessions(pool!, ALL, 10)).map((r) => [r.externalId, r]));
    assert.equal(rows.A!.model, "m1");
    assert.equal(rows.E!.model, null);
    assert.equal(rows.E!.events, 2);
    assert.equal(rows.C!.events, 0);
    assert.equal(rows.A!.projectLabel, "demo-app");
    assert.equal(rows.C!.projectLabel, null);
    assert.equal(rows.A!.totalTokens, 116 + 222);
    assert.ok(rows.A!.startedAt instanceof Date);
  });
});
