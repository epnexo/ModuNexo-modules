import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chartBarHref, validateManifest } from "@modunexo/sdk";
import { DashboardService } from "@modunexo/core/dashboard";
import { moduleRolesFor } from "@modunexo/core/data";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { createScratchDatabase } from "@modunexo/core/testing";
import { migrate } from "../helpers/migrate.ts";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import { parseFilters } from "../../modules/ai-usage/web/filters.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let service: DashboardService;

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
  service = new DashboardService(pool, registry, { moduleRoles: moduleRolesFor(pool) });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (skipReason) return t.skip(skipReason);
    await run();
  });

/** One event of `tokens` input tokens, `daysAgo` days back, for a tool that is created when it is not there yet. */
async function seed(slug: string, daysAgo: number, tokens: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const tool = (await pool!.query("insert into ai_usage.tools (slug, name) values ($1, $1) on conflict (slug) do update set name = excluded.name returning id", [slug])).rows[0].id;
  const session = (await pool!.query("insert into ai_usage.sessions (tool_id, external_id, started_at, ended_at, project_label) values ($1, $2, $3, $3, 'p') returning id", [tool, `s-${slug}-${daysAgo}-${tokens}`, at])).rows[0].id;
  await pool!.query(
    "insert into ai_usage.usage_events (tool_id, session_id, external_id, occurred_at, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens) values ($1, $2, $3, $4, 'm', $5, 0, 0, 0, 0)",
    [tool, session, `e-${slug}-${daysAgo}-${tokens}`, at, tokens],
  );
}

const chart = async (key: string) => (await service.cards(() => true)).charts.find((card) => card.moduleId === "ai-usage" && card.key === key);

describe("ai-usage's dashboard charts", () => {
  it("declares the tokens by tool, whose bars open the page of the tool they name", () => {
    assert.doesNotThrow(() => validateManifest(aiUsage));
    const declared = aiUsage.dashboard?.charts?.find((entry) => entry.key === "tokens_by_tool");
    assert.ok(declared, "a chart of tokens by tool");
    assert.equal(declared.href, "/ai-usage?tool={label}");
    assert.equal(declared.permission, "ai_usage.read");
    assert.match(aiUsage.platform, /^\^0\.1\.(4|[5-9]|\d{2,})$/, "a module that uses {label} asks for the SDK that introduced it");
  });

  guard("draws one bar per tool with the tokens of the last 30 days, the tallest first", async () => {
    await pool!.query("delete from ai_usage.usage_events");
    await seed("codex", 3, 5_000);
    await seed("claude-code", 2, 9_000);
    await seed("claude-code", 45, 7_000);
    await seed("pi", 40, 1_000);
    const card = await chart("tokens_by_tool");
    assert.ok(card);
    assert.deepEqual(card.points, [
      { label: "claude-code", value: 9_000 },
      { label: "codex", value: 5_000 },
      { label: "pi", value: 0 },
    ]);
  });

  guard("labels each bar with a tool the page accepts as its filter, so the click lands on that tool", async () => {
    const card = await chart("tokens_by_tool");
    assert.ok(card?.points);
    const known = card.points.map((point) => point.label);
    for (const point of card.points) {
      const parsed = parseFilters({ tool: point.label }, known);
      assert.equal(parsed.tool, point.label);
      assert.deepEqual(parsed.problems, []);
      assert.equal(chartBarHref(card.href, point.label), `/ai-usage?tool=${encodeURIComponent(point.label)}`);
    }
  });

  guard("keeps the tokens by day as it was, with its own link", async () => {
    const card = await chart("tokens_by_day");
    assert.ok(card);
    assert.equal(card.href, "/ai-usage");
    assert.equal(card.points?.length, 14);
  });
});
