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
import evaluate from "../../modules/observability/jobs/evaluate.ts";
import { applyContainers, type ContainerInput } from "../../modules/observability/lib/containers.ts";
import { applyInventory, type GuestInput } from "../../modules/observability/lib/guests.ts";
import { loadAlerts } from "../../modules/observability/lib/queries.ts";
import { parseRule } from "../../modules/observability/lib/rules.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
const ctx = { moduleId: "observability", jobName: "test", jobId: 1, attempt: 1, payload: null, signal: new AbortController().signal } as JobContext;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let hostId = 0;
let defaults: { name: string; kind: string; for_minutes: number }[] = [];

const box = (fields: Partial<ContainerInput> = {}): ContainerInput => ({ name: "web-1", platform: "dokploy", project: "modunexo", environment: "production", service: "web", image: "img:1", state: "running", restarts: 0, startedAt: undefined, domain: "", ...fields });
const guest = (fields: Partial<GuestInput> = {}): GuestInput => ({ vmid: 101, name: "opnsense", kind: "qemu", node: "pve", running: true, uptimeSeconds: 3600, backedUp: undefined, metrics: {}, ...fields });
const rule = (name: string, kind: string, forMinutes: number, extra = "") => pool!.query(`insert into observability.alert_rules (name, kind, threshold, for_minutes, severity ${extra === "" ? "" : ", host_name"}) values ($1, $2, 0, $3, 'warning' ${extra === "" ? "" : ", $4"})`, extra === "" ? [name, kind, forMinutes] : [name, kind, forMinutes, extra]);
const alerts = async () => (await pool!.query("select a.state, a.subject, a.project, r.name as rule from observability.alerts a join observability.alert_rules r on r.id = a.rule_id order by a.subject")).rows as { state: string; subject: string | null; project: string | null; rule: string }[];
const events = async () => (await pool!.query("select payload from core.events where type = 'observability.alert' order by id")).rows.map((row) => row.payload);

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
  defaults = (await pool.query("select name, kind, for_minutes from observability.alert_rules where kind in ('container_down', 'guest_down') order by name")).rows;
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from observability.alert_rules");
  await pool.query("delete from observability.collectors");
  await pool.query("delete from core.events");
  hostId = (await pool.query("insert into observability.collectors (host_name, version) values ('pi', '1.0.0') returning id")).rows[0].id;
});

after(async () => { await pool?.end(); await dropScratch?.(); });

describe("the entity rules", () => {
  it("ships a default rule for containers and one for guests", (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(defaults.map((row) => [row.name, row.kind]), [["Container not running", "container_down"], ["Guest down", "guest_down"]]);
  });

  it("parses them with a duration and no metric or threshold", () => {
    assert.deepEqual(parseRule({ name: "Box", kind: "container_down", forMinutes: "10", severity: "critical", enabled: "on" }), { ok: true, value: { name: "Box", kind: "container_down", metric: null, operator: ">", threshold: 0, forMinutes: 10, severity: "critical", host: null, enabled: true } });
    assert.deepEqual(parseRule({ name: "G", kind: "guest_down" }), { ok: true, value: { name: "G", kind: "guest_down", metric: null, operator: ">", threshold: 0, forMinutes: 5, severity: "warning", host: null, enabled: false } });
    assert.equal(parseRule({ name: "G", kind: "guest_down", forMinutes: "5000" }).ok, false);
  });
});

describe("container alerts", { concurrency: false }, () => {
  it("fires once a container has been out of the running state for the whole duration, naming it and its project", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 5);
    await applyContainers(hostId, ago(10), [box({ state: "exited" }), box({ name: "db-1", service: "db" })]);
    await applyContainers(hostId, ago(1), [box({ state: "exited" }), box({ name: "db-1", service: "db" })]);
    await evaluate(ctx);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), [{ state: "firing", subject: "web-1", project: "modunexo", rule: "Container not running" }]);
    const [event] = await events();
    assert.deepEqual({ state: event.state, kind: event.kind, host: event.host, subject: event.subject, project: event.project, rule: event.rule }, { state: "firing", kind: "container_down", host: "pi", subject: "web-1", project: "modunexo", rule: "Container not running" });
    assert.equal((await events()).length, 1);
  });

  it("waits for the duration, and a state that changed restarts the clock", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 5);
    await applyContainers(hostId, ago(10), [box({ state: "restarting" })]);
    await applyContainers(hostId, ago(3), [box({ state: "exited" })]);
    await applyContainers(hostId, ago(1), [box({ state: "exited" })]);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
  });

  it("raises one alert per container", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 0);
    await applyContainers(hostId, ago(2), [box({ state: "dead" }), box({ name: "db-1", state: "exited", project: "crm" })]);
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((row) => [row.subject, row.project]), [["db-1", "crm"], ["web-1", "modunexo"]]);
  });

  it("resolves when the container runs again or the platform stops listing it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 0);
    await applyContainers(hostId, ago(3), [box({ state: "exited" }), box({ name: "db-1", state: "exited" })]);
    await evaluate(ctx);
    await applyContainers(hostId, ago(1), [box({ state: "running" })]);
    await evaluate(ctx);
    assert.deepEqual((await alerts()).map((row) => [row.subject, row.state]), [["db-1", "resolved"], ["web-1", "resolved"]]);
    assert.deepEqual((await events()).map((event) => event.state), ["firing", "firing", "resolved", "resolved"]);
  });

  it("neither fires nor resolves on data that stopped arriving", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 0);
    await applyContainers(hostId, ago(60), [box({ state: "exited" })]);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
    await applyContainers(hostId, ago(2), [box({ state: "exited" })]);
    await evaluate(ctx);
    await pool!.query("update observability.containers set last_seen_at = now() - interval '1 hour'");
    await evaluate(ctx);
    assert.equal((await alerts())[0]?.state, "firing");
  });

  it("limits a rule to one host and lists the alert with its subject and project", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Container not running", "container_down", 0, "elsewhere");
    await applyContainers(hostId, ago(2), [box({ state: "exited" })]);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
    await pool!.query("update observability.alert_rules set host_name = 'pi'");
    await evaluate(ctx);
    const { firing } = await loadAlerts();
    assert.deepEqual(firing.map((alert) => [alert.host, alert.subject, alert.project, alert.kind]), [["pi", "web-1", "modunexo", "container_down"]]);
  });
});

describe("guest alerts", { concurrency: false }, () => {
  it("fires for a guest that was up and has been stopped for the duration, and resolves when it runs again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Guest down", "guest_down", 5);
    await applyInventory(hostId, ago(30), [guest(), guest({ vmid: 102, name: "never-up", running: false })]);
    await applyInventory(hostId, ago(10), [guest({ running: false }), guest({ vmid: 102, name: "never-up", running: false })]);
    await applyInventory(hostId, ago(1), [guest({ running: false }), guest({ vmid: 102, name: "never-up", running: false })]);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), [{ state: "firing", subject: "opnsense", project: null, rule: "Guest down" }]);
    assert.equal((await events())[0].subject, "opnsense");
    await applyInventory(hostId, ago(0), [guest({ uptimeSeconds: 30 })]);
    await evaluate(ctx);
    assert.equal((await alerts())[0]?.state, "resolved");
  });

  it("does not fire before the duration has passed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await rule("Guest down", "guest_down", 5);
    await applyInventory(hostId, ago(10), [guest()]);
    await applyInventory(hostId, ago(2), [guest({ running: false })]);
    await evaluate(ctx);
    assert.deepEqual(await alerts(), []);
  });
});
