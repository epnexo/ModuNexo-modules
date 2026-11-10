import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import { GET } from "../../modules/ai-usage/web/chart-data.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(aiUsage);
  await migrate(pool, registry, { moduleDirs: { "ai-usage": MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('ai-usage', 'enabled', $1)", [aiUsage.version]);
  registerModuleRuntime(pool, { current: registry });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

/** One event for `slug`, `daysAgo` days before now, in its own session. */
async function seed(slug: string, daysAgo: number, tokens: number): Promise<void> {
  const tool = (await pool!.query("insert into ai_usage.tools (slug, name) values ($1, $1) on conflict (slug) do update set name = excluded.name returning id", [slug])).rows[0].id;
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const session = (await pool!.query("insert into ai_usage.sessions (tool_id, external_id, started_at, ended_at, project_label) values ($1, $2, $3, $3, 'p') returning id", [tool, `s-${slug}-${daysAgo}`, at])).rows[0].id;
  await pool!.query(
    "insert into ai_usage.usage_events (tool_id, session_id, external_id, occurred_at, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens) values ($1, $2, $3, $4, 'm', $5, 0, 0, 0, 0)",
    [tool, session, `e-${slug}-${daysAgo}`, at, tokens],
  );
}

const ask = (query: string) => GET(new Request(`http://shell.test/ai-usage/data/daily${query}`));

beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions, ai_usage.ingest_receipts restart identity cascade");
});

describe("the chart's data route", () => {
  it("answers only the rows of the period asked for, with the days the chart draws", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await seed("codex", 0, 100);
    await seed("codex", 20, 200);
    await seed("codex", 60, 400);
    const week = await (await ask("?period=7d")).json();
    assert.deepEqual(week.daily.map((row: { totalTokens: number }) => row.totalTokens), [100]);
    assert.equal(week.period, "7d");
    assert.equal(week.to, new Date().toISOString().slice(0, 10));
    const month = await (await ask("?period=30d")).json();
    assert.deepEqual(month.daily.map((row: { totalTokens: number }) => row.totalTokens), [200, 100]);
    const all = await (await ask("?period=all")).json();
    assert.deepEqual(all.daily.map((row: { totalTokens: number }) => row.totalTokens), [400, 200, 100]);
    assert.equal(all.from, all.daily[0].day, "for all time the chart starts at the first day with data");
  });

  it("keeps to one tool when it is named", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await seed("codex", 1, 100);
    await seed("pi", 1, 900);
    const body = await (await ask("?period=7d&tool=pi")).json();
    assert.deepEqual(body.daily.map((row: { tool: string }) => row.tool), ["pi"]);
    assert.equal(body.tool, "pi");
  });

  it("refuses an unknown period or tool with 400 and says which", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await seed("codex", 1, 100);
    const period = await ask("?period=1y");
    assert.equal(period.status, 400);
    assert.match((await period.json()).error, /1y/);
    const tool = await ask("?tool=emacs");
    assert.equal(tool.status, 400);
    assert.match((await tool.json()).error, /emacs/);
  });

  it("is never cached, since it is a person's usage", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await ask("")).headers.get("cache-control"), "no-store");
    assert.equal((await ask("?period=zz")).headers.get("cache-control"), "no-store");
  });
});
