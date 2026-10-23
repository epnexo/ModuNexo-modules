import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { GET as availabilityRoute } from "../../agenda/web/svc-availability.ts";
import { POST as svcBookRoute } from "../../agenda/web/svc-book.ts";
import { POST as svcCancelRoute } from "../../agenda/web/svc-cancel.ts";
import { POST as svcRescheduleRoute } from "../../agenda/web/svc-reschedule.ts";
import { POST as bookRoute } from "../../agenda/web/book.ts";
import { POST as cancelRoute } from "../../agenda/web/cancel.ts";
import { POST as rescheduleRoute } from "../../agenda/web/reschedule.ts";
import { POST as settingsRoute } from "../../agenda/web/settings-save.ts";
import { setNowForTests } from "../../agenda/lib/clock.ts";
import { loadSettings, saveSettings } from "../../agenda/lib/settings.ts";
import agenda from "../../agenda/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../agenda/", import.meta.url));
const MON_9 = "2026-10-26T09:00:00.000Z";
const MON_930 = "2026-10-26T09:30:00.000Z";
const MON_10 = "2026-10-26T10:00:00.000Z";

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
  await pool!.query("delete from core.events");
  await pool!.query("delete from agenda.bookings");
  await saveSettings({ timezone: "UTC", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 }, HOURS);
});

const SAME = { origin: "http://shell.test", host: "shell.test" };
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = SAME) =>
  new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const json = (path: string, body: unknown) => new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const count = async () => Number((await pool!.query("select count(*)::int as n from agenda.bookings")).rows[0].n);
const eventCount = async () => Number((await pool!.query("select count(*)::int as n from core.events")).rows[0].n);
const location = (response: Response) => response.headers.get("location");
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;
const insertBooking = async (start = MON_9, status = "booked") =>
  Number((await pool!.query("insert into agenda.bookings (starts_at, ends_at, attendee_name, status) values ($1, $1::timestamptz + interval '30 minutes', 'Ada', $2) returning id", [start, status])).rows[0].id);

describe("every form route", { concurrency: false }, () => {
  const routes: [string, (request: Request) => Promise<Response>, Record<string, string>][] = [
    ["/agenda/book", bookRoute, { startsAt: MON_9, attendeeName: "Ada" }],
    ["/agenda/cancel", cancelRoute, { id: "1" }],
    ["/agenda/reschedule", rescheduleRoute, { id: "1", startsAt: MON_10 }],
    ["/agenda/settings/save", settingsRoute, { timezone: "America/Bogota", slotMinutes: "20", bufferMinutes: "0", horizonDays: "7" }],
  ];
  for (const [path, handler, fields] of routes) {
    it(`${path} refuses another site, a request with no origin and a body that is not a form, and writes nothing`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      const id = await insertBooking();
      const sent = { ...fields, id: String(id) };
      const settingsBefore = await loadSettings();
      assert.equal((await handler(form(path, sent, { origin: "http://evil.test", host: "shell.test" }))).status, 403);
      assert.equal((await handler(form(path, sent, { host: "shell.test" }))).status, 403);
      const notAForm = new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...SAME }, body: JSON.stringify(sent) });
      assert.equal((await handler(notAForm)).status, 400);
      assert.equal((await pool!.query("select status, starts_at from agenda.bookings where id = $1", [id])).rows[0].status, "booked");
      assert.equal(await count(), 1);
      assert.equal(await eventCount(), 0);
      assert.deepEqual(await loadSettings(), settingsBefore);
    });
  }
});

describe("POST /agenda/book", { concurrency: false }, () => {
  it("books the slot and sends the browser to the week of the booking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await bookRoute(form("/agenda/book", { startsAt: MON_9, attendeeName: "Ada Lovelace", contactId: "5", notes: "hi" }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/agenda?d=2026-10-26");
    const row = (await pool!.query("select attendee_name, contact_id, notes from agenda.bookings")).rows[0];
    assert.deepEqual([row.attendee_name, Number(row.contact_id), row.notes], ["Ada Lovelace", 5, "hi"]);
    assert.equal(await eventCount(), 1);
  });

  it("names the date in the zone of the settings", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveSettings({ timezone: "Asia/Kolkata", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 }, [{ weekday: 1, startMinute: 30, endMinute: 120 }]);
    const response = await bookRoute(form("/agenda/book", { startsAt: "2026-10-25T19:00:00Z", attendeeName: "Ada" })); // Monday 00:30 in Kolkata
    assert.equal(location(response), "/agenda?d=2026-10-26");
  });

  it("answers 400 naming the field, and 409 for a time that is not free", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const bad = await bookRoute(form("/agenda/book", { startsAt: "tomorrow", attendeeName: "Ada" }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"startsAt"/);
    assert.equal((await bookRoute(form("/agenda/book", { startsAt: MON_9, attendeeName: "" }))).status, 400);
    assert.equal((await bookRoute(form("/agenda/book", { startsAt: MON_9, attendeeName: "Ada", contactId: "x" }))).status, 400);
    const taken = await bookRoute(form("/agenda/book", { startsAt: "2026-10-26T09:10:00Z", attendeeName: "Ada" }));
    assert.equal(taken.status, 409);
    assert.equal(await errorOf(taken), "That time is not available.");
    assert.equal(await count(), 0);
  });
});

describe("POST /agenda/cancel and /agenda/reschedule", { concurrency: false }, () => {
  it("cancel the booking and send the browser back to the agenda", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertBooking();
    const response = await cancelRoute(form("/agenda/cancel", { id: String(id) }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/agenda");
    assert.equal((await pool!.query("select status from agenda.bookings where id = $1", [id])).rows[0].status, "cancelled");
  });

  it("answer 400 for an id that is not a number and 404 for a booking that does not exist", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await cancelRoute(form("/agenda/cancel", { id: "x" }))).status, 400);
    assert.equal((await cancelRoute(form("/agenda/cancel", { id: "424242" }))).status, 404);
    assert.equal((await rescheduleRoute(form("/agenda/reschedule", { id: "x", startsAt: MON_10 }))).status, 400);
    assert.equal((await rescheduleRoute(form("/agenda/reschedule", { id: "424242", startsAt: MON_10 }))).status, 404);
  });

  it("reschedule moves the booking and goes to the week of the new time", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertBooking();
    const response = await rescheduleRoute(form("/agenda/reschedule", { id: String(id), startsAt: MON_10 }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/agenda?d=2026-10-26");
    assert.equal((await pool!.query("select starts_at from agenda.bookings where id = $1", [id])).rows[0].starts_at.toISOString(), MON_10);
  });

  it("reschedule answers 400 for a time it cannot read, 409 for a taken slot and 409 for a cancelled booking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertBooking(MON_9);
    await insertBooking(MON_10);
    const bad = await rescheduleRoute(form("/agenda/reschedule", { id: String(id), startsAt: "soon" }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"startsAt"/);
    assert.equal((await rescheduleRoute(form("/agenda/reschedule", { id: String(id), startsAt: MON_10 }))).status, 409);
    const cancelled = await insertBooking(MON_930, "cancelled");
    const refused = await rescheduleRoute(form("/agenda/reschedule", { id: String(cancelled), startsAt: "2026-10-26T11:00:00Z" }));
    assert.equal(refused.status, 409);
    assert.equal(await errorOf(refused), "A cancelled booking cannot be rescheduled.");
  });
});

describe("POST /agenda/settings/save", { concurrency: false }, () => {
  it("saves the zone, the numbers and the hours, and goes back to the settings page", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await settingsRoute(form("/agenda/settings/save", { timezone: "America/Bogota", slotMinutes: "20", bufferMinutes: "5", horizonDays: "7", d1_start: "08:00", d1_end: "12:00" }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/agenda/settings");
    assert.deepEqual(await loadSettings(), { timezone: "America/Bogota", slotMinutes: 20, bufferMinutes: 5, horizonDays: 7 });
    assert.deepEqual((await pool!.query("select weekday, start_minute, end_minute from agenda.weekly_hours")).rows, [{ weekday: 1, start_minute: 480, end_minute: 720 }]);
  });

  it("answers 400 naming the field and keeps what was saved", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await settingsRoute(form("/agenda/settings/save", { timezone: "Mars/Base", slotMinutes: "20", bufferMinutes: "5", horizonDays: "7" }));
    assert.equal(response.status, 400);
    assert.match(await errorOf(response), /"timezone"/);
    assert.equal((await loadSettings()).timezone, "UTC");
    assert.equal(Number((await pool!.query("select count(*)::int as n from agenda.weekly_hours")).rows[0].n), 5);
  });
});

describe("GET /svc/agenda/availability", { concurrency: false }, () => {
  const get = (query = "") => availabilityRoute(new Request(`http://shell.test/svc/agenda/availability${query}`));

  it("lists the free slots with the zone and the slot length", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await get("?days=2");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { timezone: string; slotMinutes: number; slots: { startsAt: string; endsAt: string }[] };
    assert.equal(body.timezone, "UTC");
    assert.equal(body.slotMinutes, 30);
    assert.equal(body.slots[0]!.startsAt, MON_9);
    assert.equal(body.slots[0]!.endsAt, MON_930);
    assert.equal(body.slots.length, 16, "Monday 09:00 to 17:00 in 30-minute slots");
  });

  it("leaves out a booked slot, and narrows to the days asked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await insertBooking(MON_9);
    const body = (await (await get("?days=2")).json()) as { slots: { startsAt: string }[] };
    assert.equal(body.slots.some((s) => s.startsAt === MON_9), false);
    assert.equal(body.slots.length, 15);
    const none = (await (await get("?days=1")).json()) as { slots: unknown[] };
    assert.deepEqual(none.slots, []);
  });

  it("answers 400 for days that are not a number from 1 to 90", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const days of ["abc", "0", "91", "-1", "1.5"]) assert.equal((await get(`?days=${days}`)).status, 400, days);
  });
});

describe("POST /svc/agenda/bookings", { concurrency: false }, () => {
  it("books a free slot and answers 201 with the booking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await svcBookRoute(json("/svc/agenda/bookings", { startsAt: MON_9, attendeeName: "Ada", contactId: 9, notes: "from the agent" }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { id: Number((await pool!.query("select id from agenda.bookings")).rows[0].id), startsAt: MON_9, endsAt: MON_930 });
    assert.equal(await eventCount(), 1);
  });

  it("answers 409 not_available for a taken slot and 400 for a body it cannot use", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await insertBooking(MON_9);
    const taken = await svcBookRoute(json("/svc/agenda/bookings", { startsAt: MON_9, attendeeName: "Grace" }));
    assert.equal(taken.status, 409);
    assert.equal(await errorOf(taken), "not_available");
    for (const body of ["not json", "[]", "null", { startsAt: MON_10 }, { startsAt: "soon", attendeeName: "A" }]) {
      assert.equal((await svcBookRoute(json("/svc/agenda/bookings", body))).status, 400, JSON.stringify(body));
    }
    assert.equal(await count(), 1);
  });

  it("answers 413 for a body over 16 KiB", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const big = await svcBookRoute(json("/svc/agenda/bookings", { startsAt: MON_9, attendeeName: "A", notes: "n".repeat(20_000) }));
    assert.equal(big.status, 413);
  });
});

describe("POST /svc/agenda/bookings/cancel and /reschedule", { concurrency: false }, () => {
  it("cancel answers ok and says whether anything changed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertBooking();
    assert.deepEqual(await (await svcCancelRoute(json("/svc/agenda/bookings/cancel", { id }))).json(), { ok: true, changed: true });
    assert.deepEqual(await (await svcCancelRoute(json("/svc/agenda/bookings/cancel", { id }))).json(), { ok: true, changed: false });
    assert.equal((await svcCancelRoute(json("/svc/agenda/bookings/cancel", { id: 424242 }))).status, 404);
    assert.equal((await svcCancelRoute(json("/svc/agenda/bookings/cancel", { id: "x" }))).status, 400);
  });

  it("reschedule moves the booking, and answers 404, 409 and 400 where it should", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertBooking(MON_9);
    await insertBooking(MON_10);
    const moved = await svcRescheduleRoute(json("/svc/agenda/bookings/reschedule", { id, startsAt: MON_930 }));
    assert.equal(moved.status, 200);
    assert.deepEqual(await moved.json(), { ok: true, changed: true });
    assert.equal((await svcRescheduleRoute(json("/svc/agenda/bookings/reschedule", { id, startsAt: MON_10 }))).status, 409);
    assert.equal((await svcRescheduleRoute(json("/svc/agenda/bookings/reschedule", { id: 424242, startsAt: MON_930 }))).status, 404);
    assert.equal((await svcRescheduleRoute(json("/svc/agenda/bookings/reschedule", { id, startsAt: "soon" }))).status, 400);
  });
});
