import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import { loadTrends } from "../../modules/observability/lib/queries.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(Date.UTC(2026, 10, 15, 12, 30));
const today = Date.UTC(2026, 10, 15);

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let collectorId = 0;

const daily = (metric: string, values: number[]) => Promise.all(values.map((value, index) =>
  pool!.query("insert into observability.samples_daily (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, $3, $4, $4, $4, 1)", [collectorId, new Date(today - (values.length - index) * DAY), metric, value])));
const hourly = (metric: string, rows: Array<[number, number]>) => Promise.all(rows.map(([avg, max], index) =>
  pool!.query("insert into observability.samples_hourly (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, $3, $4, $4, $5, 1)", [collectorId, new Date(Math.floor(now.getTime() / HOUR) * HOUR - (rows.length - index) * HOUR), metric, avg, max])));

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) { skipReason = scratch.skipReason; return; }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(observability);
  await migrate(pool, registry, { moduleDirs: { observability: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('observability', 'enabled', $1)", [observability.version]);
  registerModuleRuntime(pool, { current: registry });
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from observability.collectors");
  collectorId = (await pool.query("insert into observability.collectors (host_name, version) values ('pi', '1.0.0') returning id")).rows[0].id;
});

after(async () => { await pool?.end(); await dropScratch?.(); });

describe("loading a host's trends", { concurrency: false }, () => {
  it("compares the weeks, forecasts the disk and finds the spike from the rollups", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await daily("cpuPercent", [...Array(7).fill(10), ...Array(7).fill(20)]);
    await daily("diskUsedPercent", [50, 52, 54, 56, 58, 60]);
    await hourly("cpuPercent", [...Array.from({ length: 24 }, (): [number, number] => [10, 12]), [30, 80]]);
    const trends = await loadTrends(collectorId, now);
    assert.deepEqual(trends.weeks.map((week) => [week.metric, week.current, week.previous]), [["cpuPercent", 20, 10]]);
    assert.equal(trends.disk.state, "filling");
    if (trends.disk.state === "filling") assert.ok(Math.abs(trends.disk.daysLeft - 20) < 1e-6, String(trends.disk.daysLeft));
    assert.deepEqual(trends.spikes.map((spike) => [spike.metric, spike.value]), [["cpuPercent", 80]]);
  });

  it("leaves out today's partial day and other hosts' history", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await daily("diskUsedPercent", [50, 52, 54]);
    await pool!.query("insert into observability.samples_daily (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'diskUsedPercent', 99, 99, 99, 1)", [collectorId, new Date(today)]);
    const other = (await pool!.query("insert into observability.collectors (host_name, version) values ('other', '1.0.0') returning id")).rows[0].id;
    await pool!.query("insert into observability.samples_daily (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'diskUsedPercent', 90, 90, 90, 1)", [other, new Date(today - DAY)]);
    const trends = await loadTrends(collectorId, now);
    assert.equal(trends.disk.state === "filling" ? Math.round(trends.disk.perDay) : -1, 2);
    assert.equal(trends.disk.state === "filling" ? trends.disk.daysLeft > 20 : false, true);
  });

  it("answers with empty trends for a host with no history", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(await loadTrends(collectorId, now), { weeks: [], disk: { state: "unknown", daysOfData: 0, needed: 3 }, spikes: [] });
  });
});
