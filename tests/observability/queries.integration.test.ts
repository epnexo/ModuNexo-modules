import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import { loadAlerts, loadFleet, loadRules, loadSeries } from "../../modules/observability/lib/queries.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let hostId = 0;

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
  await pool.query("delete from observability.alert_rules");
  await pool.query("delete from observability.collectors");
  hostId = await collector("host-a");
});

after(async () => { await pool?.end(); await dropScratch?.(); });

const collector = async (name: string): Promise<number> => (await pool!.query("insert into observability.collectors (host_name, version) values ($1, '1.0.0') returning id", [name])).rows[0].id;
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const sample = (id: number, at: Date, metrics: Record<string, number>) =>
  pool!.query("insert into observability.samples (collector_id, collected_at, metrics) values ($1, $2, $3)", [id, at, JSON.stringify(metrics)]);
/** The start of the bucket of `seconds` that ended `back` buckets ago, so a test never straddles a bucket edge. */
const bucketStart = (seconds: number, back: number): number => (Math.floor(Date.now() / 1000 / seconds) - back) * seconds * 1000;

describe("loadFleet", { concurrency: false }, () => {
  it("tells online, stale and offline hosts apart from the age of their newest sample", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const stale = await collector("host-b");
    await collector("host-c");
    await sample(hostId, minutesAgo(1), { cpuPercent: 12 });
    await sample(hostId, minutesAgo(30), { cpuPercent: 99 });
    await sample(stale, minutesAgo(6), { cpuPercent: 5 });
    const fleet = await loadFleet();
    assert.deepEqual(fleet.map((row) => [row.hostName, row.status]), [["host-a", "online"], ["host-b", "stale"], ["host-c", "offline"]]);
    assert.deepEqual(fleet[0]?.metrics, { cpuPercent: 12 });
    assert.deepEqual(fleet[2]?.metrics, {});
  });

  it("counts the alerts firing on each host", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const rule = (await pool!.query("insert into observability.alert_rules (name, metric, threshold) values ('r', 'cpuPercent', 90) returning id")).rows[0].id;
    await pool!.query("insert into observability.alerts (rule_id, collector_id, severity, state) values ($1, $2, 'warning', 'firing')", [rule, hostId]);
    await pool!.query("insert into observability.alerts (rule_id, collector_id, severity, state, resolved_at) values ($1, $2, 'warning', 'resolved', now())", [rule, hostId]);
    assert.equal((await loadFleet())[0]?.firing, 1);
  });
});

describe("loadSeries", { concurrency: false }, () => {
  it("returns every raw sample of the last hour for one metric of one host", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const other = await collector("host-b");
    await sample(hostId, minutesAgo(3), { cpuPercent: 10, load1: 1 });
    await sample(hostId, minutesAgo(2), { cpuPercent: 20 });
    await sample(hostId, minutesAgo(1), { cpuPercent: 30 });
    await sample(hostId, minutesAgo(120), { cpuPercent: 99 });
    await sample(other, minutesAgo(1), { cpuPercent: 77 });
    const points = await loadSeries(hostId, "cpuPercent", "1h");
    assert.deepEqual(points.map((p) => p.avg), [10, 20, 30]);
    assert.ok(points.every((p, i) => p.min === p.avg && p.max === p.avg && (i === 0 || p.t > points[i - 1]!.t)));
  });

  it("averages raw samples into ten-minute buckets with their min and max for 24 hours", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const start = bucketStart(600, 6);
    await sample(hostId, new Date(start + 60_000), { cpuPercent: 10 });
    await sample(hostId, new Date(start + 120_000), { cpuPercent: 30 });
    assert.deepEqual(await loadSeries(hostId, "cpuPercent", "24h"), [{ t: start, avg: 20, min: 10, max: 30 }]);
  });

  it("reads 7 days from the hourly rollups", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const start = bucketStart(3600, 2);
    await pool!.query("insert into observability.samples_hourly (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'cpuPercent', 20, 10, 30, 2)", [hostId, new Date(start)]);
    assert.deepEqual(await loadSeries(hostId, "cpuPercent", "7d"), [{ t: start, avg: 20, min: 10, max: 30 }]);
  });

  it("merges hourly rollups into six-hour buckets weighted by their sample count for 30 days", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const start = bucketStart(21_600, 2);
    const insert = (at: number, avg: number, min: number, max: number, count: number) =>
      pool!.query("insert into observability.samples_hourly (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'cpuPercent', $3, $4, $5, $6)", [hostId, new Date(at), avg, min, max, count]);
    await insert(start, 10, 10, 10, 1);
    await insert(start + 3_600_000, 30, 20, 40, 3);
    assert.deepEqual(await loadSeries(hostId, "cpuPercent", "30d"), [{ t: start, avg: 25, min: 10, max: 40 }]);
  });

  it("reads 90 days from the daily rollups", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const start = bucketStart(86_400, 3);
    await pool!.query("insert into observability.samples_daily (collector_id, bucket, metric, avg_value, min_value, max_value, sample_count) values ($1, $2, 'cpuPercent', 50, 5, 95, 1440)", [hostId, new Date(start)]);
    assert.deepEqual(await loadSeries(hostId, "cpuPercent", "90d"), [{ t: start, avg: 50, min: 5, max: 95 }]);
  });
});

describe("loadAlerts and loadRules", { concurrency: false }, () => {
  it("lists firing alerts apart from the recent history, with the rule and the host", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const rule = (await pool!.query("insert into observability.alert_rules (name, metric, operator, threshold, severity) values ('Low disk space', 'diskUsedPercent', '>', 85, 'critical') returning id")).rows[0].id;
    await pool!.query("insert into observability.alerts (rule_id, collector_id, severity, state, last_value, started_at, resolved_at) values ($1, $2, 'critical', 'resolved', 90, now() - interval '2 hours', now() - interval '1 hour')", [rule, hostId]);
    await pool!.query("insert into observability.alerts (rule_id, collector_id, severity, state, last_value) values ($1, $2, 'critical', 'firing', 92)", [rule, hostId]);
    const { firing, history } = await loadAlerts();
    assert.deepEqual(firing.map((a) => [a.host, a.rule, a.metric, a.operator, a.threshold, a.value, a.severity]), [["host-a", "Low disk space", "diskUsedPercent", ">", 85, 92, "critical"]]);
    assert.deepEqual(history.map((a) => a.state), ["firing", "resolved"]);
  });

  it("lists the rules by name", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pool!.query("insert into observability.alert_rules (name, metric, threshold) values ('b', 'x', 1), ('a', 'y', 2)");
    assert.deepEqual((await loadRules()).map((rule) => rule.name), ["a", "b"]);
  });
});
