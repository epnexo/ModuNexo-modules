import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { bookSlot, bookingInput, cancelBooking, getBooking, rescheduleBooking, weekBookings } from "../../agenda/lib/bookings.ts";
import { saveSettings } from "../../agenda/lib/settings.ts";
import { freeSlots } from "../../agenda/lib/slots.ts";
import agenda from "../../agenda/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../agenda/", import.meta.url));
const NOW = new Date("2026-10-25T00:00:00Z"); // a Sunday; 2026-10-26 is the Monday the default hours open
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
  await pool?.end();
  await dropScratch?.();
});

const DEFAULT_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("delete from core.events");
  await pool!.query("delete from agenda.bookings");
  await saveSettings({ timezone: "UTC", slotMinutes: 30, bufferMinutes: 0, horizonDays: 14 }, DEFAULT_HOURS);
});

const events = async () => (await pool!.query("select type, payload from core.events order by id")).rows as { type: string; payload: Record<string, unknown> }[];
const count = async () => Number((await pool!.query("select count(*)::int as n from agenda.bookings")).rows[0].n);
const input = (startsAt: string, over: Record<string, unknown> = {}) => {
  const out = bookingInput({ startsAt, attendeeName: "Ada Lovelace", ...over });
  assert.ok(out.ok, JSON.stringify(out));
  return out.value;
};
const book = async (startsAt: string, over: Record<string, unknown> = {}) => {
  const made = await bookSlot(input(startsAt, over), NOW);
  assert.ok(made.ok, JSON.stringify(made));
  return made.id;
};

describe("bookingInput", () => {
  it("reads the instant, the attendee, the optional contact id and the notes", () => {
    const out = bookingInput({ startsAt: "2026-10-26T09:00:00Z", attendeeName: "  Ada  ", contactId: "12", notes: " hi " });
    assert.deepEqual(out, { ok: true, value: { startsAt: new Date("2026-10-26T09:00:00Z"), attendeeName: "Ada", contactId: 12, notes: "hi" } });
    assert.deepEqual(bookingInput({ startsAt: "2026-10-26T04:00:00-05:00", attendeeName: "A" }), { ok: true, value: { startsAt: new Date("2026-10-26T09:00:00Z"), attendeeName: "A", contactId: null, notes: null } });
  });

  it("refuses an instant without a zone, a name that is blank or long, a contact id that is not a number and notes that are too long", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["startsAt", { startsAt: "2026-10-26T09:00:00" }],
      ["startsAt", { startsAt: "tomorrow" }],
      ["startsAt", { startsAt: "" }],
      ["startsAt", { startsAt: "2026-13-40T09:00:00Z" }],
      ["attendeeName", { attendeeName: "  " }],
      ["attendeeName", { attendeeName: "x".repeat(201) }],
      ["attendeeName", { attendeeName: "a\u0000" }],
      ["contactId", { contactId: "abc" }],
      ["contactId", { contactId: "1".repeat(16) }],
      ["notes", { notes: "n".repeat(2001) }],
      ["notes", { notes: "a\u0000b" }],
    ];
    for (const [field, over] of bad) {
      const out = bookingInput({ startsAt: "2026-10-26T09:00:00Z", attendeeName: "Ada", ...over });
      assert.equal(out.ok, false, JSON.stringify(over));
      if (!out.ok) assert.match(out.error, new RegExp(`"${field}"`), JSON.stringify(over));
    }
  });
});

describe("bookSlot", { concurrency: false }, () => {
  it("stores the booking for a free slot, lasting one slot, and announces it once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9, { contactId: "7", notes: "first visit" });
    const row = (await pool!.query("select starts_at, ends_at, status, attendee_name, contact_id, notes from agenda.bookings where id = $1", [id])).rows[0];
    assert.deepEqual([row.starts_at.toISOString(), row.ends_at.toISOString(), row.status, row.attendee_name, Number(row.contact_id), row.notes], [MON_9, MON_930, "booked", "Ada Lovelace", 7, "first visit"]);
    assert.deepEqual(await events(), [{ type: "agenda.booking.updated", payload: { bookingId: id, contactId: 7, change: "created", status: "booked", startsAt: MON_9, endsAt: MON_930 } }]);
  });

  it("refuses a time that is not a free slot, and stores and announces nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const refused = [
      "2026-10-26T09:10:00Z", // not on the slot grid
      "2026-10-26T08:30:00Z", // before the hours
      "2026-10-26T17:00:00Z", // after the hours
      "2026-10-31T10:00:00Z", // a Saturday
      "2026-10-24T10:00:00Z", // in the past
      "2026-12-01T09:00:00Z", // beyond the horizon
    ];
    for (const when of refused) {
      assert.deepEqual(await bookSlot(input(when), NOW), { ok: false, error: "not_available" }, when);
    }
    assert.equal(await count(), 0);
    assert.deepEqual(await events(), []);
    assert.equal((await bookSlot(input("2026-10-26T16:30:00Z"), NOW)).ok, true, "the last slot that ends exactly at closing is free");
  });

  it("refuses a slot that is already booked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await book(MON_9);
    assert.deepEqual(await bookSlot(input(MON_9, { attendeeName: "Grace" }), NOW), { ok: false, error: "not_available" });
    assert.equal(await count(), 1);
    assert.equal((await events()).length, 1);
  });

  it("keeps the buffer between two bookings", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveSettings({ timezone: "UTC", slotMinutes: 30, bufferMinutes: 15, horizonDays: 14 }, DEFAULT_HOURS);
    await book(MON_9);
    assert.deepEqual(await bookSlot(input(MON_930), NOW), { ok: false, error: "not_available" }, "right after: no buffer");
    assert.equal((await bookSlot(input(MON_10), NOW)).ok, true, "a gap of 30 minutes is more than the buffer");
  });

  it("lets only one of several requests for the same slot through when they arrive together", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => bookSlot(input(MON_10, { attendeeName: `Person ${index}` }), NOW)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === "not_available"), true);
    assert.equal(await count(), 1);
    assert.equal((await events()).length, 1);
  });

  it("keeps the buffer even when neighbouring slots are requested together", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveSettings({ timezone: "UTC", slotMinutes: 30, bufferMinutes: 30, horizonDays: 14 }, DEFAULT_HOURS);
    const results = await Promise.all([MON_9, MON_930, MON_10, "2026-10-26T10:30:00Z", "2026-10-26T11:00:00Z"].map((when) => bookSlot(input(when), NOW)));
    const rows = (await pool!.query("select starts_at, ends_at from agenda.bookings order by starts_at")).rows;
    assert.equal(results.filter((r) => r.ok).length, rows.length);
    for (let index = 1; index < rows.length; index += 1) {
      const gap = rows[index].starts_at.getTime() - rows[index - 1].ends_at.getTime();
      assert.ok(gap >= 30 * 60_000, `gap ${gap}`);
    }
  });
});

describe("cancelBooking", { concurrency: false }, () => {
  it("frees the slot, announces it once and changes nothing the second time", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9);
    await pool!.query("delete from core.events");
    assert.deepEqual(await cancelBooking(id), { ok: true, changed: true });
    const row = (await pool!.query("select status, cancelled_at from agenda.bookings where id = $1", [id])).rows[0];
    assert.equal(row.status, "cancelled");
    assert.ok(row.cancelled_at instanceof Date);
    assert.deepEqual(await events(), [{ type: "agenda.booking.updated", payload: { bookingId: id, contactId: null, change: "cancelled", status: "cancelled", startsAt: MON_9, endsAt: MON_930 } }]);
    assert.deepEqual(await cancelBooking(id), { ok: true, changed: false });
    assert.equal((await events()).length, 1);
    assert.equal((await bookSlot(input(MON_9, { attendeeName: "Grace" }), NOW)).ok, true, "the slot can be booked again");
  });

  it("says not_found for a booking that does not exist", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(await cancelBooking(424242), { ok: false, error: "not_found" });
    assert.deepEqual(await events(), []);
  });
});

describe("rescheduleBooking", { concurrency: false }, () => {
  it("moves a booking to another free slot and announces it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9, { contactId: "3" });
    await pool!.query("delete from core.events");
    assert.deepEqual(await rescheduleBooking(id, new Date(MON_10), NOW), { ok: true, changed: true });
    const row = (await pool!.query("select starts_at, ends_at, status from agenda.bookings where id = $1", [id])).rows[0];
    assert.deepEqual([row.starts_at.toISOString(), row.ends_at.toISOString(), row.status], [MON_10, "2026-10-26T10:30:00.000Z", "booked"]);
    assert.deepEqual(await events(), [{ type: "agenda.booking.updated", payload: { bookingId: id, contactId: 3, change: "rescheduled", status: "booked", startsAt: MON_10, endsAt: "2026-10-26T10:30:00.000Z" } }]);
    assert.equal((await bookSlot(input(MON_9, { attendeeName: "Grace" }), NOW)).ok, true, "its old slot is free");
  });

  it("can move next to its own old slot, and to the same slot as a no-op without an event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9);
    await pool!.query("delete from core.events");
    assert.deepEqual(await rescheduleBooking(id, new Date(MON_9), NOW), { ok: true, changed: false });
    assert.deepEqual(await events(), []);
    assert.deepEqual(await rescheduleBooking(id, new Date(MON_930), NOW), { ok: true, changed: true });
  });

  it("refuses a slot that is taken or not free, a cancelled booking and an unknown one, and changes nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9);
    await book(MON_10, { attendeeName: "Grace" });
    await pool!.query("delete from core.events");
    assert.deepEqual(await rescheduleBooking(id, new Date(MON_10), NOW), { ok: false, error: "not_available" });
    assert.deepEqual(await rescheduleBooking(id, new Date("2026-10-26T09:10:00Z"), NOW), { ok: false, error: "not_available" });
    assert.deepEqual(await rescheduleBooking(424242, new Date(MON_930), NOW), { ok: false, error: "not_found" });
    await cancelBooking(id);
    await pool!.query("delete from core.events");
    assert.deepEqual(await rescheduleBooking(id, new Date(MON_930), NOW), { ok: false, error: "not_booked" });
    assert.deepEqual(await events(), []);
    assert.equal(new Date((await pool!.query("select starts_at from agenda.bookings where id = $1", [id])).rows[0].starts_at).toISOString(), MON_9);
  });
});

describe("freeSlots, getBooking and weekBookings", { concurrency: false }, () => {
  it("leave out the booked slot and bring it back when the booking is cancelled", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const has = async () => (await freeSlots(NOW)).some((slot) => slot.startsAt.toISOString() === MON_9);
    assert.equal(await has(), true);
    const id = await book(MON_9);
    assert.equal(await has(), false);
    await cancelBooking(id);
    assert.equal(await has(), true);
  });

  it("get one booking, or null", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await book(MON_9, { notes: "n" });
    const row = await getBooking(id);
    assert.deepEqual([row?.attendeeName, row?.status, row?.notes, row?.startsAt.toISOString()], ["Ada Lovelace", "booked", "n", MON_9]);
    assert.equal(await getBooking(424242), null);
  });

  it("list the bookings of a range oldest first, cancelled ones included and marked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const late = await book(MON_10, { attendeeName: "Late" });
    const early = await book(MON_9, { attendeeName: "Early" });
    await cancelBooking(late);
    await book("2026-11-03T09:00:00Z", { attendeeName: "Next week" });
    const rows = await weekBookings(new Date("2026-10-26T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
    assert.deepEqual(rows.map((r) => [r.id, r.attendeeName, r.status]), [[early, "Early", "booked"], [late, "Late", "cancelled"]]);
  });
});
