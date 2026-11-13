import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { JobContext } from "@modunexo/sdk";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import rollup from "../../modules/observability/jobs/rollup.ts";
import retention from "../../modules/observability/jobs/retention.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
const ctx = { moduleId: "observability", jobName: "test", jobId: 1, attempt: 1, payload: null, signal: new AbortController().signal } as JobContext;
const DAY = 86_400_000;

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let collectorId = 0;

/** Midnight UTC `days` ago: a fixed day, so a bucket never straddles midnight whatever time the test runs. */
const dayStart = (days: number): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * DAY);
};
const at = (day: Date, hours: number, minutes: number): string => new Date(day.getTime() + (hours * 60 + minutes) * 60_000).toISOString();

const sample = (when: string, metrics: Record<string, number>) =>
  pool!.query("insert into observability.samples (collector_id, collected_at, metrics) values ($1, $2, $3)", [collectorId, when, JSON.stringify(metrics)]);
const rows = async (table: string) =>
  (await pool!.query(`select metric, bucket, avg_value, min_value, max_value, sample_count from observability.${table} where collector_id = $1 order by metric, bucket`, [collectorId])).rows;

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
  collectorId = (await pool.query("insert into observability.collectors (host_name, version) values ('rollup-host', '1.0.0') returning id")).rows[0].id;
});

after(async () => { await pool?.end(); await dropScratch?.(); });

describe("the rollup job", { concurrency: false }, () => {
  it("aggregates raw samples into hourly buckets per metric", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const day = dayStart(3);
    await sample(at(day, 10, 10), { cpuPercent: 10, load1: 1 });
    await sample(at(day, 10, 20), { cpuPercent: 30, load1: 3 });
    await sample(at(day, 11, 5), { cpuPercent: 50 });
    await rollup(ctx);
    const hourly = (await rows("samples_hourly")).map((r) => ({ ...r, bucket: r.bucket.toISOString() }));
    assert.deepEqual(hourly, [
      { metric: "cpuPercent", bucket: at(day, 10, 0), avg_value: 20, min_value: 10, max_value: 30, sample_count: 2 },
      { metric: "cpuPercent", bucket: at(day, 11, 0), avg_value: 50, min_value: 50, max_value: 50, sample_count: 1 },
      { metric: "load1", bucket: at(day, 10, 0), avg_value: 2, min_value: 1, max_value: 3, sample_count: 2 },
    ]);
  });

  it("builds daily buckets weighted by how many samples each hour had", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const day = dayStart(3);
    await sample(at(day, 10, 10), { cpuPercent: 10 });
    await sample(at(day, 10, 20), { cpuPercent: 30 });
    await sample(at(day, 11, 5), { cpuPercent: 50 });
    await rollup(ctx);
    const daily = (await rows("samples_daily")).map((r) => ({ ...r, bucket: r.bucket.toISOString() }));
    assert.deepEqual(daily, [{ metric: "cpuPercent", bucket: day.toISOString(), avg_value: 30, min_value: 10, max_value: 50, sample_count: 3 }]);
  });

  it("is idempotent and picks up a late sample in the latest hour", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const day = dayStart(3);
    await sample(at(day, 10, 10), { cpuPercent: 10 });
    await rollup(ctx);
    await rollup(ctx);
    assert.equal((await rows("samples_hourly"))[0].sample_count, 1);
    await sample(at(day, 10, 40), { cpuPercent: 30 });
    await rollup(ctx);
    const hourly = await rows("samples_hourly");
    assert.equal(hourly.length, 1);
    assert.deepEqual([hourly[0].avg_value, hourly[0].sample_count], [20, 2]);
    assert.equal((await rows("samples_daily"))[0].sample_count, 2);
  });
});

describe("the retention job", { concurrency: false }, () => {
  it("drops old raw samples only once they are rolled up, and keeps recent ones", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await sample(at(dayStart(20), 10, 0), { cpuPercent: 1 });
    await sample(at(dayStart(1), 10, 0), { cpuPercent: 2 });
    await retention(ctx);
    assert.equal((await pool!.query("select count(*)::int as n from observability.samples")).rows[0].n, 2, "nothing rolled up yet, so nothing is dropped");
    await rollup(ctx);
    await retention(ctx);
    const left = await pool!.query("select metrics from observability.samples");
    assert.deepEqual(left.rows.map((r) => r.metrics), [{ cpuPercent: 2 }]);
  });

  it("drops hourly rollups after 180 days and daily rollups after 2 years", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const insert = (table: string, bucket: Date) =>
      pool!.query(`insert into observability.${table} (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'cpuPercent', 1, 1, 1, 1)`, [collectorId, bucket]);
    await insert("samples_hourly", dayStart(200));
    await insert("samples_hourly", dayStart(100));
    await insert("samples_daily", dayStart(800));
    await insert("samples_daily", dayStart(400));
    await retention(ctx);
    assert.equal((await rows("samples_hourly")).length, 1);
    assert.equal((await rows("samples_daily")).length, 1);
  });
});
