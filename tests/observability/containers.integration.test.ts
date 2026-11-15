import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import pg from "pg";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import { applyContainers, parseContainers, type ContainerInput } from "../../modules/observability/lib/containers.ts";
import { loadContainers } from "../../modules/observability/lib/queries.ts";
import ContainersView from "../../modules/observability/web/containers-view.tsx";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let collectorId = 0;

const box = (fields: Partial<ContainerInput> = {}): ContainerInput => ({ name: "web-1", platform: "dokploy", project: "modunexo", environment: "production", service: "web", image: "modunexo/web:1.2.0", state: "running", restarts: 0, startedAt: new Date("2026-11-10T08:00:00Z"), domain: "crm.example.com", ...fields });
const t0 = new Date("2026-11-15T10:00:00Z");
const t1 = new Date("2026-11-15T10:01:00Z");

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

describe("parsing a container snapshot", () => {
  const body = (containers: unknown) => ({ hostName: "pi", collectedAt: t0.toISOString(), containers });

  it("accepts containers with optional fields left out", () => {
    const parsed = parseContainers(body([{ name: "db-1", platform: "docker", state: "running" }]));
    assert.deepEqual(parsed?.containers, [{ name: "db-1", platform: "docker", project: "", environment: "", service: "", image: "", state: "running", restarts: 0, startedAt: undefined, domain: "" }]);
  });

  it("rejects what cannot be trusted and accepts an empty list (everything stopped being seen)", () => {
    for (const containers of [
      "x", [{ name: "", platform: "docker", state: "running" }], [{ name: "a", platform: "swarm", state: "running" }], [{ name: "a", platform: "docker", state: "weird" }],
      [{ name: "a", platform: "docker", state: "running", restarts: -1 }], [{ name: "a", platform: "docker", state: "running", startedAt: "nope" }],
      [{ name: "a", platform: "docker", state: "running" }, { name: "a", platform: "docker", state: "exited" }],
    ]) assert.equal(parseContainers(body(containers)), null, JSON.stringify(containers));
    assert.deepEqual(parseContainers(body([]))?.containers, []);
    assert.equal(parseContainers({ hostName: "", collectedAt: t0.toISOString(), containers: [] }), null);
  });
});

describe("applying a container snapshot", { concurrency: false }, () => {
  it("records each container with its project, image and state", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyContainers(collectorId, t0, [box(), box({ name: "db-1", service: "db", image: "postgres:16", domain: "" })]);
    const rows = (await pool!.query("select name, platform, project, state, restarts, domain, gone_at from observability.containers order by name")).rows;
    assert.deepEqual(rows.map((row) => row.name), ["db-1", "web-1"]);
    assert.equal(rows[1].project, "modunexo");
    assert.equal(rows[1].domain, "crm.example.com");
    assert.equal(rows[1].gone_at, null);
  });

  it("updates state and restarts on the next snapshot without duplicating", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyContainers(collectorId, t0, [box()]);
    await applyContainers(collectorId, t1, [box({ state: "restarting", restarts: 3 })]);
    const rows = (await pool!.query("select state, restarts, last_seen_at from observability.containers")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "restarting");
    assert.equal(rows[0].restarts, 3);
    assert.equal(rows[0].last_seen_at.getTime(), t1.getTime());
  });

  it("marks a container that left the snapshot as gone, and clears it when it comes back", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyContainers(collectorId, t0, [box(), box({ name: "old-1" })]);
    await applyContainers(collectorId, t1, [box()]);
    const gone = (await pool!.query("select gone_at from observability.containers where name = 'old-1'")).rows[0];
    assert.equal(gone.gone_at.getTime(), t1.getTime());
    await applyContainers(collectorId, new Date(t1.getTime() + 60_000), [box(), box({ name: "old-1" })]);
    assert.equal((await pool!.query("select gone_at from observability.containers where name = 'old-1'")).rows[0].gone_at, null);
  });

  it("never touches the containers of another collector", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const other = (await pool!.query("insert into observability.collectors (host_name, version) values ('vps-home', '1.0.0') returning id")).rows[0].id;
    await applyContainers(other, t0, [box({ name: "app-1", platform: "coolify" })]);
    await applyContainers(collectorId, t1, [box()]);
    assert.equal((await pool!.query("select gone_at from observability.containers where name = 'app-1'")).rows[0].gone_at, null);
  });
});

describe("loading and showing containers", { concurrency: false }, () => {
  it("loads live containers first, grouped by project", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyContainers(collectorId, t0, [box({ name: "z-1", project: "zeta" }), box({ name: "a-1", project: "alpha", state: "exited" }), box({ name: "m-1", project: "alpha" })]);
    await applyContainers(collectorId, t1, [box({ name: "z-1", project: "zeta" }), box({ name: "a-1", project: "alpha", state: "exited" })]);
    const rows = await loadContainers();
    assert.deepEqual(rows.map((row) => row.name), ["a-1", "z-1", "m-1"]);
    assert.equal(rows[0]!.hostName, "pi");
    assert.equal(rows[2]!.gone, true);
  });

  it("renders the count by state, the project groups and the platform of each container", () => {
    const rows = [
      { id: 1, hostName: "pi", ...box(), gone: false },
      { id: 2, hostName: "vps-home", ...box({ name: "app-1", platform: "coolify", project: "shop", state: "restarting", restarts: 7, domain: "" }), gone: false },
    ];
    const html = renderToStaticMarkup(createElement(ContainersView, { containers: rows, now: t0.getTime() }));
    assert.match(html, /Running<\/dt><dd class="stat-value">1/);
    assert.match(html, /Restarting<\/dt><dd class="stat-value">1/);
    assert.match(html, />modunexo</);
    assert.match(html, />shop</);
    assert.match(html, /Dokploy/);
    assert.match(html, /Coolify/);
    assert.match(html, /crm\.example\.com/);
    assert.match(html, /7 restarts/);
  });

  it("says so when no container has been reported", () => {
    assert.match(renderToStaticMarkup(createElement(ContainersView, { containers: [], now: t0.getTime() })), /No containers reported yet/);
  });
});
