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
import { POST } from "../../modules/ai-usage/web/svc-ingest.ts";

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

beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions restart identity cascade");
});

const post = (body: unknown) => POST(new Request("http://shell.test/svc/ai-usage/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ai_usage.${table}`)).rows[0].n);

const batch = (tokens = 10) => ({
  tool: { slug: "claude-code", name: "Claude Code" },
  sessions: [{ externalId: "s1", startedAt: "2026-10-01T10:00:00Z", endedAt: "2026-10-01T11:00:00Z", projectLabel: "demo" }],
  usage: [{ externalId: "e1", sessionExternalId: "s1", occurredAt: "2026-10-01T10:05:00Z", model: "m1", inputTokens: tokens, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 5, reasoningTokens: null }],
  activity: [
    { kind: "prompt", externalId: "p1", sessionExternalId: "s1" },
    { kind: "tool_call", externalId: "t1", sessionExternalId: "s1" },
    { kind: "turn", externalId: "u1", sessionExternalId: "s1", durationMs: 2500 },
  ],
});

describe("POST /svc/ai-usage/ingest", () => {
  it("stores the batch and answers what it added", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await post(batch());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sessionsInserted: 1, eventsInserted: 1, tokensInserted: 15, activityReceived: 3 });
    assert.equal(await count("sessions"), 1);
    assert.equal(await count("usage_events"), 1);
    assert.equal(await count("activity_items"), 3);
    const summary = (await pool!.query("select message_count, tool_call_count, duration_ms from ai_usage.session_summary")).rows[0];
    assert.deepEqual([Number(summary.message_count), Number(summary.tool_call_count), Number(summary.duration_ms)], [1, 1, 2500]);
  });

  it("changes nothing when the same batch is sent again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(batch());
    const again = await post(batch());
    assert.deepEqual(await again.json(), { sessionsInserted: 0, eventsInserted: 0, tokensInserted: 0, activityReceived: 3 });
    assert.equal(await count("usage_events"), 1);
    assert.equal(await count("activity_items"), 3);
  });

  it("fills in the name, skill and failure flag of an item stored before it had them, and never overwrites one it has", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(batch());
    const named = batch();
    named.activity[1] = { kind: "tool_call", externalId: "t1", sessionExternalId: "s1", name: "Skill", skill: "demo-skill", failed: false } as (typeof named.activity)[number];
    const again = await post(named);
    assert.equal(again.status, 200);
    const row = () => pool!.query("select name, skill, failed from ai_usage.activity_items where external_id = 't1'").then((r) => r.rows[0]);
    assert.deepEqual(await row(), { name: "Skill", skill: "demo-skill", failed: false });
    named.activity[1] = { kind: "tool_call", externalId: "t1", sessionExternalId: "s1", name: "Bash", skill: "other", failed: true } as (typeof named.activity)[number];
    await post(named);
    assert.deepEqual(await row(), { name: "Skill", skill: "demo-skill", failed: false });
    assert.equal(await count("activity_items"), 3);
  });

  it("refuses the database a name that holds a path separator", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(batch());
    await assert.rejects(pool!.query("update ai_usage.activity_items set name = '/home/user/x' where external_id = 't1'"), /check/);
  });

  it("keeps the larger counter when a message that was still streaming is sent again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post(batch(10));
    await post(batch(40));
    await post(batch(20));
    assert.equal(Number((await pool!.query("select input_tokens from ai_usage.usage_events")).rows[0].input_tokens), 40);
  });

  it("refuses a bad body and writes nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post([])).status, 400);
    const orphan = batch();
    orphan.usage[0]!.sessionExternalId = "missing";
    const response = await post(orphan);
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /sessionExternalId/);
    assert.equal(await count("sessions"), 0);
  });

  it("refuses a body over the limit with 413", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await post(JSON.stringify({ tool: { slug: "codex", name: "x".repeat(2_100_000) } }));
    assert.equal(response.status, 413);
  });
});
