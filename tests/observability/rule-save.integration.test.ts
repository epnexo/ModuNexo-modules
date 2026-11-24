import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "../helpers/migrate.ts";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import { POST } from "../../modules/observability/web/rule-save.ts";

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

beforeEach(async () => { await pool?.query("delete from observability.alert_rules"); });
after(async () => { await pool?.end(); await dropScratch?.(); });

const submit = (fields: Record<string, string>, origin: string | null = "http://shell.test") =>
  POST(new Request("http://shell.test/observability/rules/save", { method: "POST", headers: { host: "shell.test", ...(origin === null ? {} : { origin }) }, body: new URLSearchParams(fields) }));
const rules = async () => (await pool!.query("select id, name, kind, metric, threshold, for_minutes, severity, enabled from observability.alert_rules order by id")).rows;
const form = { name: "Low disk", kind: "metric", metric: "diskUsedPercent", operator: ">", threshold: "85", forMinutes: "15", severity: "critical", enabled: "on" };

describe("POST /observability/rules/save", { concurrency: false }, () => {
  it("adds a rule and sends the browser back to the rules page", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await submit(form);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/observability/rules");
    assert.deepEqual((await rules()).map(({ id, ...rest }) => rest), [{ name: "Low disk", kind: "metric", metric: "diskUsedPercent", threshold: 85, for_minutes: 15, severity: "critical", enabled: true }]);
  });

  it("updates the rule named by id, including turning it off", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await submit(form);
    const [row] = await rules();
    const response = await submit({ ...form, id: String(row!.id), threshold: "90", enabled: undefined as unknown as string });
    assert.equal(response.status, 303);
    const [after] = await rules();
    assert.deepEqual([after!.threshold, after!.enabled], [90, false]);
  });

  it("refuses an unknown rule, a duplicate name and a bad field without writing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await submit(form);
    assert.equal((await submit({ ...form, id: "999999" })).status, 404, "updating a rule that does not exist");
    assert.equal((await submit({ ...form, name: "Low disk" })).status, 409);
    assert.equal((await submit({ ...form, name: "Bad", threshold: "abc" })).status, 400);
    assert.equal((await submit({ ...form, name: "Bad id", id: "abc" })).status, 400);
    assert.equal((await rules()).length, 1);
  });

  it("refuses a request that does not come from this site", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await submit(form, "http://evil.test")).status, 403);
    assert.equal((await submit(form, null)).status, 403);
    assert.equal((await rules()).length, 0);
  });
});
