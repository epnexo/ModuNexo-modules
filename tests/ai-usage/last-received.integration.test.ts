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
import { getLastReceived } from "../../modules/ai-usage/web/queries.ts";

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
  await pool!.query("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions, ai_usage.ingest_receipts restart identity cascade");
});

const send = (slug: string, name: string) =>
  POST(new Request("http://shell.test/svc/ai-usage/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: { slug, name }, sessions: [], usage: [], activity: [] }) }));

describe("last data received", () => {
  it("is empty before anything was received", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(await getLastReceived(pool!), []);
  });

  it("records one row per tool when a batch arrives and moves it forward when another arrives", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await send("claude-code", "Claude Code")).status, 200);
    const first = (await getLastReceived(pool!)).find((row) => row.tool === "claude-code");
    assert.ok(first, "a row for claude-code");
    assert.ok(Math.abs(first.receivedAt.getTime() - Date.now()) < 60_000, "close to now");
    await pool!.query("update ai_usage.ingest_receipts set received_at = now() - interval '2 hours'");
    await send("claude-code", "Claude Code");
    const second = (await getLastReceived(pool!)).filter((row) => row.tool === "claude-code");
    assert.equal(second.length, 1);
    assert.ok(Date.now() - second[0]!.receivedAt.getTime() < 60_000, "moved back to now");
    assert.equal(await pool!.query("select count(*)::int as n from ai_usage.ingest_receipts").then((r) => r.rows[0].n), 1);
  });

  it("also counts a local run, which writes ingest_state instead of receipts, and keeps tools apart", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await send("claude-code", "Claude Code");
    await pool!.query("update ai_usage.ingest_receipts set received_at = now() - interval '5 days'");
    const codex = Number((await pool!.query("select id from ai_usage.tools where slug = 'codex'")).rows[0].id);
    await pool!.query("insert into ai_usage.ingest_state (tool_id, source_key, size_bytes, mtime_ms, byte_offset, updated_at) values ($1, 'k', 1, 1, 1, now() - interval '1 hour')", [codex]);
    const rows = await getLastReceived(pool!);
    const age = (slug: string) => Date.now() - rows.find((row) => row.tool === slug)!.receivedAt.getTime();
    assert.ok(age("claude-code") > 4 * 86_400_000);
    assert.ok(age("codex") > 3_000_000 && age("codex") < 4_000_000);
  });
});
