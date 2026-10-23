import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { validateManifest } from "@modunexo/sdk";
import AgendaPage from "../../agenda/web/agenda-page.tsx";
import SettingsPage from "../../agenda/web/settings-page.tsx";
import { setNowForTests } from "../../agenda/lib/clock.ts";
import { saveSettings } from "../../agenda/lib/settings.ts";
import agenda from "../../agenda/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../agenda/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

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
  registry.register(agenda);
  await migrate(pool, registry, { moduleDirs: { agenda: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('agenda', 'enabled', $1)", [agenda.version]);
  registerModuleRuntime(pool, { current: registry });
});

after(async () => {
  setNowForTests(null);
  await pool?.end();
  await dropScratch?.();
});

const HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
beforeEach(async () => {
  if (skipReason) return;
  setNowForTests(new Date("2026-10-25T00:00:00Z"));
  await pool!.query("delete from agenda.bookings");
  await saveSettings({ timezone: "UTC", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 }, HOURS);
});

const html = async (page: Promise<unknown>) => renderToStaticMarkup((await page) as never);
const agendaHtml = (params: { d?: string } = {}) => html(AgendaPage({ searchParams: Promise.resolve(params) }));
const insert = async (start: string, name = "Ada Lovelace", status = "booked") =>
  Number((await pool!.query("insert into agenda.bookings (starts_at, ends_at, attendee_name, status) values ($1, $1::timestamptz + interval '30 minutes', $2, $3) returning id", [start, name, status])).rows[0].id);

describe("the agenda manifest", () => {
  it("opens the two pages for readers, the form routes for writers and the service routes by scope, none public", () => {
    const checked = validateManifest(agenda);
    const byPath = new Map(checked.pages?.map((page) => [page.path, page]));
    for (const path of ["/agenda", "/agenda/settings"]) {
      assert.equal(byPath.get(path)?.kind, "page", path);
      assert.equal(byPath.get(path)?.permission, "agenda.read", path);
    }
    for (const path of ["/agenda/book", "/agenda/cancel", "/agenda/reschedule", "/agenda/settings/save"]) {
      assert.equal(byPath.get(path)?.kind, "route", path);
      assert.deepEqual(byPath.get(path)?.methods, ["POST"], path);
      assert.equal(byPath.get(path)?.permission, "agenda.write", path);
    }
    const service: [string, string, string][] = [["/svc/agenda/availability", "GET", "availability.read"], ["/svc/agenda/bookings", "POST", "bookings.write"], ["/svc/agenda/bookings/cancel", "POST", "bookings.write"], ["/svc/agenda/bookings/reschedule", "POST", "bookings.write"]];
    for (const [path, method, scope] of service) {
      assert.deepEqual(byPath.get(path)?.methods, [method], path);
      assert.equal(byPath.get(path)?.scope, scope, path);
    }
    assert.deepEqual(checked.scopes?.map((s) => s.key), ["availability.read", "bookings.write"]);
    assert.equal(checked.pages?.some((page) => page.public !== undefined), false);
    assert.deepEqual(checked.nav?.map((entry) => [entry.label, entry.href, entry.permission]), [["Agenda", "/agenda", "agenda.read"]]);
  });
});

describe("/agenda", { concurrency: false }, () => {
  it("shows the week asked for, with its days, the zone and the links to the weeks around it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await agendaHtml({ d: "2026-10-28" });
    for (const day of ["Mon 26 Oct", "Tue 27 Oct", "Wed 28 Oct", "Thu 29 Oct", "Fri 30 Oct", "Sat 31 Oct", "Sun 1 Nov"]) assert.match(out, new RegExp(day), day);
    assert.match(out, /Times are in UTC/);
    assert.match(out, /href="\/agenda\?d=2026-10-19"/);
    assert.match(out, /href="\/agenda\?d=2026-11-02"/);
    assert.match(out, /href="\/agenda\/settings"/);
  });

  it("opens on the week of today when there is no day or it is not a date", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.match(await agendaHtml(), /Mon 19 Oct/);
    assert.match(await agendaHtml({ d: "nonsense" }), /Mon 19 Oct/);
  });

  it("offers the free slots of the week in the booking form, with the times of the agenda's zone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await agendaHtml({ d: "2026-10-26" });
    assert.match(out, /action="\/agenda\/book"/);
    assert.match(out, /name="attendeeName"/);
    assert.match(out, /<option value="2026-10-26T09:00:00\.000Z"[^>]*>Mon 26 Oct 09:00<\/option>/);
    assert.doesNotMatch(out, /value="2026-11-02T09:00:00\.000Z"/, "a slot of another week is not offered");
    await saveSettings({ timezone: "America/Bogota", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 }, HOURS);
    assert.match(await agendaHtml({ d: "2026-10-26" }), /<option value="2026-10-26T14:00:00\.000Z"[^>]*>Mon 26 Oct 09:00<\/option>/);
  });

  it("says there is no free slot, and offers no booking form, when the week has none", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await agendaHtml({ d: "2026-06-01" });
    assert.match(out, /No free slot this week/);
    assert.doesNotMatch(out, /action="\/agenda\/book"/);
  });

  it("lists a booking with its time, a cancel form and a reschedule form, and takes its slot out of the options", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insert("2026-10-26T09:00:00Z");
    const out = await agendaHtml({ d: "2026-10-26" });
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /09:00/);
    assert.match(out, /action="\/agenda\/cancel"/);
    assert.match(out, /action="\/agenda\/reschedule"/);
    assert.match(out, new RegExp(`<input type="hidden" name="id" value="${id}"`));
    assert.doesNotMatch(out, /<option value="2026-10-26T09:00:00\.000Z"/);
  });

  it("shows a cancelled booking as cancelled, with no way to cancel or move it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await insert("2026-10-26T09:00:00Z", "Grace Hopper", "cancelled");
    const out = await agendaHtml({ d: "2026-10-26" });
    assert.match(out, /Grace Hopper/);
    assert.match(out, /Cancelled/);
    assert.doesNotMatch(out, /action="\/agenda\/cancel"/);
    assert.doesNotMatch(out, /action="\/agenda\/reschedule"/);
  });

  it("escapes the attendee's name", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await insert("2026-10-26T09:00:00Z", '<script>alert("x")</script>');
    const out = await agendaHtml({ d: "2026-10-26" });
    assert.doesNotMatch(out, /<script>alert/);
    assert.match(out, /&lt;script&gt;/);
  });
});

describe("/agenda/settings", { concurrency: false }, () => {
  it("shows the current zone, slot, buffer, horizon and the hours of each weekday, and posts to the save route", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveSettings({ timezone: "America/Bogota", slotMinutes: 45, bufferMinutes: 10, horizonDays: 30 }, [{ weekday: 1, startMinute: 480, endMinute: 720 }]);
    const out = await html(SettingsPage());
    assert.match(out, /action="\/agenda\/settings\/save"/);
    assert.match(out, /name="timezone"[^>]*value="America\/Bogota"|value="America\/Bogota"[^>]*name="timezone"/);
    assert.match(out, /name="slotMinutes"[^>]*value="45"|value="45"[^>]*name="slotMinutes"/);
    assert.match(out, /name="bufferMinutes"[^>]*value="10"|value="10"[^>]*name="bufferMinutes"/);
    assert.match(out, /name="horizonDays"[^>]*value="30"|value="30"[^>]*name="horizonDays"/);
    assert.match(out, /name="d1_start"[^>]*value="08:00"|value="08:00"[^>]*name="d1_start"/);
    assert.match(out, /name="d1_end"[^>]*value="12:00"|value="12:00"[^>]*name="d1_end"/);
    for (const day of [0, 2, 3, 4, 5, 6]) assert.match(out, new RegExp(`name="d${day}_start"`), `d${day}`);
    assert.doesNotMatch(out, /name="d2_start"[^>]*value="\d/, "a closed day has an empty window");
  });
});
