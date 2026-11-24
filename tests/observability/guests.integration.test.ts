import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { JobContext } from "@modunexo/sdk";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "../helpers/migrate.ts";
import { createScratchDatabase } from "@modunexo/core/testing";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import observability from "../../modules/observability/manifest.ts";
import rollup from "../../modules/observability/jobs/rollup.ts";
import retention from "../../modules/observability/jobs/retention.ts";
import { applyInventory, parseInventory, type GuestInput } from "../../modules/observability/lib/guests.ts";
import { loadGuest, loadGuestSeries, loadGuestSessions, loadGuests } from "../../modules/observability/lib/queries.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/observability/", import.meta.url));
const ctx = { moduleId: "observability", jobName: "test", jobId: 1, attempt: 1, payload: null, signal: new AbortController().signal } as JobContext;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let collectorId = 0;

const guest = (fields: Partial<GuestInput> = {}): GuestInput => ({ vmid: 101, name: "opnsense", kind: "qemu", node: "pve", running: true, uptimeSeconds: 3600, backedUp: false, metrics: { cpuPercent: 10 }, ...fields });
const t0 = new Date(Date.now() - 2 * DAY);
const later = (ms: number) => new Date(t0.getTime() + ms);
const sessions = async () => (await pool!.query("select started_at, ended_at from observability.guest_sessions order by started_at")).rows as { started_at: Date; ended_at: Date | null }[];

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
  collectorId = (await pool.query("insert into observability.collectors (host_name, version) values ('proxmox', '1.0.0') returning id")).rows[0].id;
});

after(async () => { await pool?.end(); await dropScratch?.(); });

describe("parsing an inventory", () => {
  const body = (guests: unknown) => ({ hostName: "proxmox", collectedAt: t0.toISOString(), guests });

  it("accepts guests with numeric metrics and optional fields", () => {
    const parsed = parseInventory(body([{ vmid: 101, name: "opnsense", kind: "qemu", running: true, metrics: { cpuPercent: 1.5 } }]));
    assert.deepEqual(parsed?.guests, [{ vmid: 101, name: "opnsense", kind: "qemu", node: "", running: true, uptimeSeconds: undefined, backedUp: undefined, metrics: { cpuPercent: 1.5 } }]);
  });

  it("rejects what cannot be trusted", () => {
    for (const guests of [
      "x", [], [{ vmid: 1.5, name: "a", kind: "qemu", running: true }], [{ vmid: 1, name: "", kind: "qemu", running: true }],
      [{ vmid: 1, name: "a", kind: "docker", running: true }], [{ vmid: 1, name: "a", kind: "lxc", running: "yes" }],
      [{ vmid: 1, name: "a", kind: "lxc", running: true, metrics: { cpuPercent: "5" } }],
      [{ vmid: 1, name: "a", kind: "lxc", running: true }, { vmid: 1, name: "b", kind: "lxc", running: true }],
    ]) assert.equal(parseInventory(body(guests)), null, JSON.stringify(guests));
    assert.equal(parseInventory({ hostName: "", collectedAt: t0.toISOString(), guests: [guest()] }), null);
    assert.equal(parseInventory({ hostName: "p", collectedAt: "nope", guests: [guest()] }), null);
  });
});

describe("applying an inventory", { concurrency: false }, () => {
  it("registers the guest, opens a session at its boot time and stores a sample", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyInventory(collectorId, t0, [guest()]);
    const row = (await pool!.query("select * from observability.guests")).rows[0];
    assert.equal(row.name, "opnsense");
    assert.equal(row.running, true);
    assert.equal(row.backed_up, false);
    assert.equal(row.last_up_at.getTime(), t0.getTime());
    assert.deepEqual((await sessions()).map((s) => [s.started_at.getTime(), s.ended_at]), [[t0.getTime() - HOUR, null]]);
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples")).rows[0].n, 1);
  });

  it("keeps one session while the guest stays up and closes it when it stops", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyInventory(collectorId, t0, [guest()]);
    await applyInventory(collectorId, later(60_000), [guest({ uptimeSeconds: 3660 })]);
    assert.equal((await sessions()).length, 1);
    await applyInventory(collectorId, later(120_000), [guest({ running: false, uptimeSeconds: undefined, metrics: {} })]);
    const [session] = await sessions();
    assert.equal(session!.ended_at?.getTime(), later(120_000).getTime());
    const row = (await pool!.query("select running, last_up_at from observability.guests")).rows[0];
    assert.equal(row.running, false);
    assert.equal(row.last_up_at.getTime(), later(60_000).getTime());
  });

  it("opens a new session when the guest rebooted between two polls", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyInventory(collectorId, t0, [guest({ uptimeSeconds: 7200 })]);
    await applyInventory(collectorId, later(60_000), [guest({ uptimeSeconds: 20 })]);
    const all = await sessions();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.ended_at?.getTime(), all[1]!.started_at.getTime());
    assert.equal(all[1]!.ended_at, null);
  });

  it("updates the name and node, and stores no sample when the guest sends no metrics", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyInventory(collectorId, t0, [guest({ metrics: {} })]);
    await applyInventory(collectorId, later(60_000), [guest({ name: "firewall", node: "pve2", metrics: {} })]);
    const row = (await pool!.query("select name, node from observability.guests")).rows[0];
    assert.deepEqual(row, { name: "firewall", node: "pve2" });
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples")).rows[0].n, 0);
  });
});

describe("reading guests", { concurrency: false }, () => {
  it("lists guests with the time up in each window and finds one by id", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const now = new Date();
    await applyInventory(collectorId, new Date(now.getTime() - 3 * DAY), [guest({ uptimeSeconds: 0 })]);
    await applyInventory(collectorId, new Date(now.getTime() - 2 * DAY), [guest({ running: false, uptimeSeconds: undefined, metrics: {} })]);
    await applyInventory(collectorId, new Date(now.getTime() - 1 * DAY), [guest({ uptimeSeconds: 0 })]);
    const [row] = await loadGuests(collectorId, now);
    assert.equal(row!.name, "opnsense");
    assert.equal(row!.running, true);
    assert.ok(Math.abs(row!.upSeconds["7d"]! - 2 * DAY / 1000) < 5, String(row!.upSeconds["7d"]));
    assert.ok(row!.availability["7d"]! > 60 && row!.availability["7d"]! < 70, String(row!.availability["7d"]));
    assert.equal((await loadGuest(row!.id))?.vmid, 101);
    assert.equal(await loadGuest(999_999), null);
    const list = await loadGuestSessions(row!.id);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.endedAt, null);
  });
});

describe("guest history", { concurrency: false }, () => {
  it("rolls guest samples up and serves a series from them", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const day = new Date(Date.UTC(2026, 0, 1));
    await applyInventory(collectorId, new Date(day.getTime() + 10 * HOUR), [guest({ metrics: { cpuPercent: 10 } })]);
    await applyInventory(collectorId, new Date(day.getTime() + 10 * HOUR + 600_000), [guest({ metrics: { cpuPercent: 30 } })]);
    await rollup(ctx);
    const rows = (await pool!.query("select metric, avg_value, min_value, max_value, sample_count from observability.guest_samples_hourly")).rows;
    assert.deepEqual(rows, [{ metric: "cpuPercent", avg_value: 20, min_value: 10, max_value: 30, sample_count: 2 }]);
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples_daily")).rows[0].n, 1);
    const id = (await pool!.query("select id from observability.guests")).rows[0].id;
    const raw = await loadGuestSeries(id, "cpuPercent", "1h", new Date(day.getTime() + 10 * HOUR + 700_000));
    assert.deepEqual(raw.map((p) => p.avg), [10, 30]);
  });

  it("drops old guest samples only after they were rolled up", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await applyInventory(collectorId, new Date(Date.now() - 20 * DAY), [guest()]);
    await applyInventory(collectorId, new Date(Date.now() - 19 * DAY), [guest()]);
    await retention(ctx);
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples")).rows[0].n, 2, "not rolled up yet");
    await rollup(ctx);
    await retention(ctx);
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples")).rows[0].n, 1, "the newest bucket keeps its raw samples");
    assert.equal((await pool!.query("select count(*)::int as n from observability.guest_samples_hourly")).rows[0].n, 2);
  });
});
