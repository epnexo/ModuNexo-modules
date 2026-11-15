import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
import evaluate from "../../modules/observability/jobs/evaluate.ts";
import { deliver } from "../../modules/observability/lib/webhook.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
const ctx = { moduleId: "observability", jobName: "test", jobId: 1, attempt: 1, payload: null, signal: new AbortController().signal } as JobContext;

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
  await pool.query("delete from core.events");
  hostId = (await pool.query("insert into observability.collectors (host_name, version) values ('alert-host', '1.0.0') returning id")).rows[0].id;
});

after(async () => { await pool?.end(); await dropScratch?.(); });

/** One sample a minute for the last `minutes` minutes, newest `endedAgo` minutes ago. */
const series = (metric: string, value: number, minutes: number, endedAgo = 0) =>
  pool!.query(
    `insert into observability.samples (collector_id, collected_at, metrics)
     select $1, now() - make_interval(mins => g), jsonb_build_object($2::text, $3::float8) from generate_series($4::int, $4::int + $5::int) g`,
    [hostId, metric, value, endedAgo, minutes],
  );
const rule = (fields: { name?: string; kind?: string; metric?: string | null; operator?: string; threshold: number; forMinutes?: number; severity?: string; host?: string | null; enabled?: boolean }) =>
  pool!.query(
    "insert into observability.alert_rules (name, kind, metric, operator, threshold, for_minutes, severity, host_name, enabled) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
    [fields.name ?? "test rule", fields.kind ?? "metric", fields.metric === undefined ? "diskUsedPercent" : fields.metric, fields.operator ?? ">", fields.threshold, fields.forMinutes ?? 0, fields.severity ?? "warning", fields.host ?? null, fields.enabled ?? true],
  );
const alerts = async () => (await pool!.query("select state, severity, last_value from observability.alerts order by id")).rows;
const events = async () => (await pool!.query("select payload from core.events where type = 'observability.alert' order by id")).rows.map((r) => r.payload);

describe("the alert evaluator", { concurrency: false }, () => {
  it("fires once a metric has violated its threshold for the whole window, and publishes the event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ name: "Disk almost full", threshold: 85, forMinutes: 15, severity: "critical" });
    await series("diskUsedPercent", 90, 16);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), [{ state: "firing", severity: "critical", last_value: 90 }]);
    const [event] = await events();
    assert.deepEqual({ state: event.state, rule: event.rule, host: event.host, metric: event.metric, value: event.value, threshold: event.threshold, severity: event.severity }, { state: "firing", rule: "Disk almost full", host: "alert-host", metric: "diskUsedPercent", value: 90, threshold: 85, severity: "critical" });
  });

  it("does not fire when the data does not yet cover the window", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ threshold: 85, forMinutes: 15 });
    await series("diskUsedPercent", 90, 4);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
    assert.deepEqual(await events(), []);
  });

  it("keeps one open alert per rule and host however many times it runs", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ threshold: 85, forMinutes: 5 });
    await series("diskUsedPercent", 90, 6);
    await evaluate(ctx);
    await evaluate(ctx);
    assert.equal((await alerts()).length, 1);
    assert.equal((await events()).length, 1);
  });

  it("resolves when a fresh sample is back under the threshold and publishes the resolution", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ threshold: 85, forMinutes: 5 });
    await series("diskUsedPercent", 90, 6, 1);
    await evaluate(ctx);
    await pool!.query("insert into observability.samples (collector_id, collected_at, metrics) values ($1, now(), '{\"diskUsedPercent\": 40}')", [hostId]);
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((a) => a.state), ["resolved"]);
    assert.deepEqual((await events()).map((e) => e.state), ["firing", "resolved"]);
  });

  it("leaves an open alert untouched when the host sends no fresh data", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ threshold: 85, forMinutes: 5 });
    await series("diskUsedPercent", 90, 6, 1);
    await evaluate(ctx);
    await pool!.query("update observability.samples set collected_at = collected_at - interval '30 minutes'");
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((a) => a.state), ["firing"]);
    assert.equal((await events()).length, 1);
  });

  it("fires an offline rule from the age of the last sample", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ name: "Host offline", kind: "offline", metric: null, threshold: 5, severity: "critical" });
    await series("diskUsedPercent", 10, 2, 10);
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((a) => a.state), ["firing"]);
    await pool!.query("insert into observability.samples (collector_id, collected_at, metrics) values ($1, now(), '{\"diskUsedPercent\": 10}')", [hostId]);
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((a) => a.state), ["resolved"]);
  });

  it("ignores disabled rules and rules scoped to another host", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule({ name: "disabled", threshold: 85, enabled: false });
    await rule({ name: "elsewhere", threshold: 85, host: "other-host" });
    await series("diskUsedPercent", 90, 3);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
  });

  it("ships default rules for offline hosts, disk, CPU and temperature", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const fresh = await createScratchDatabase();
    if (!fresh.url) return t.skip(fresh.skipReason);
    const seeded = createPool(fresh.url);
    try {
      const registry = new Registry();
      registry.registerCore();
      registry.register(observability);
      await migrate(seeded, registry, { moduleDirs: { observability: MODULE_DIR } });
      const names = (await seeded.query("select name, kind from observability.alert_rules order by name")).rows;
      assert.deepEqual(names.map((r) => r.name), ["Container not running", "Guest down", "High CPU", "High temperature", "Host offline", "Low disk space"]);
      assert.equal(names.find((r) => r.name === "Host offline")?.kind, "offline");
    } finally {
      await seeded.end();
      await fresh.drop();
    }
  });
});

describe("the webhook delivery", { concurrency: false }, () => {
  const listen = async (status: number) => {
    const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { received.push({ headers: req.headers, body }); res.statusCode = status; res.end("{}"); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/hook`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  it("posts the alert as JSON with the bearer secret", async () => {
    const hook = await listen(200);
    try {
      await deliver(hook.url, "s3cret", { state: "firing", host: "pi" }, AbortSignal.timeout(5000));
      assert.equal(hook.received.length, 1);
      assert.equal(hook.received[0]?.headers.authorization, "Bearer s3cret");
      assert.deepEqual(JSON.parse(hook.received[0]?.body ?? "null"), { state: "firing", host: "pi" });
    } finally { await hook.close(); }
  });

  it("sends no authorization header without a secret", async () => {
    const hook = await listen(200);
    try {
      await deliver(hook.url, null, { a: 1 }, AbortSignal.timeout(5000));
      assert.equal(hook.received[0]?.headers.authorization, undefined);
    } finally { await hook.close(); }
  });

  it("fails with the status only, so the platform retries and nothing private leaks", async () => {
    const hook = await listen(500);
    try {
      await assert.rejects(deliver(hook.url, "s3cret", { a: 1 }, AbortSignal.timeout(5000)), (error: Error) => error.message === "The alert webhook answered HTTP 500." && !error.message.includes("s3cret"));
    } finally { await hook.close(); }
  });

  it("refuses an address that is not http or https", async () => {
    await assert.rejects(deliver("file:///etc/passwd", null, {}, AbortSignal.timeout(1000)), /must start with http:\/\/ or https:\/\//);
  });
});
