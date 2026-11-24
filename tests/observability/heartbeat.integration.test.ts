import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "../helpers/migrate.ts";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import { POST } from "../../modules/observability/web/heartbeat.ts";
import { POST as ingest } from "../../modules/observability/web/ingest.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

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

after(async () => { await pool?.end(); await dropScratch?.(); });

describe("POST /svc/observability/heartbeat", { concurrency: false }, () => {
  it("records a sanitized collector heartbeat", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await POST(new Request("http://shell.test/svc/observability/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "pi-01", version: "1.0.0", capabilities: ["cpu_temperature"], payloadShape: { cpuTemperature: "number" } }) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "connected" });
    const row = (await pool!.query("select host_name, version, capabilities, payload_shape, last_seen_at from observability.collectors")).rows[0];
    assert.deepEqual({ ...row, last_seen_at: typeof row.last_seen_at }, { host_name: "pi-01", version: "1.0.0", capabilities: ["cpu_temperature"], payload_shape: { cpuTemperature: "number" }, last_seen_at: "object" });
  });

  it("accepts numeric metrics only from a registered collector", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await POST(new Request("http://shell.test/svc/observability/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "pi-02", version: "1.0.0" }) }));
    const response = await ingest(new Request("http://shell.test/svc/observability/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "pi-02", collectedAt: "2026-11-08T12:00:00Z", metrics: { cpuTemperature: 42.5 } }) }));
    assert.equal(response.status, 202);
    assert.deepEqual((await pool!.query("select metrics from observability.samples")).rows[0].metrics, { cpuTemperature: 42.5 });
  });

  it("refuses payload metadata that could retain secret values", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await POST(new Request("http://shell.test/svc/observability/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName: "pi-01", version: "1.0.0", capabilities: ["cpu_temperature"], payloadShape: { apiToken: "string" } }) }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "payloadShape contains a sensitive field." });
  });
});
