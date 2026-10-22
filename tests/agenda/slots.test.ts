import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSlots, type Busy } from "../../agenda/lib/slots.ts";
import type { Settings, Window } from "../../agenda/lib/settings.ts";

const settings = (over: Partial<Settings> = {}): Settings => ({ timezone: "UTC", slotMinutes: 60, bufferMinutes: 0, horizonDays: 14, ...over });
const monday = (startMinute: number, endMinute: number): Window => ({ weekday: 1, startMinute, endMinute });
const at = (text: string): Date => new Date(text);
const starts = (list: { startsAt: Date }[]): string[] => list.map((slot) => slot.startsAt.toISOString());
const busy = (from: string, to: string): Busy => ({ startsAt: at(from), endsAt: at(to) });
const SUNDAY = at("2026-10-25T00:00:00Z"); // 2026-10-26 is a Monday

describe("computeSlots", () => {
  it("cuts each window into slots from its start, on every matching day of the horizon, oldest first", () => {
    const out = computeSlots({ settings: settings(), hours: [monday(540, 720)], busy: [], now: SUNDAY });
    assert.deepEqual(starts(out), ["2026-10-26T09:00:00.000Z", "2026-10-26T10:00:00.000Z", "2026-10-26T11:00:00.000Z", "2026-11-02T09:00:00.000Z", "2026-11-02T10:00:00.000Z", "2026-11-02T11:00:00.000Z"]);
    assert.equal(out[0]!.endsAt.toISOString(), "2026-10-26T10:00:00.000Z");
  });

  it("keeps only slots that end inside the window", () => {
    const out = computeSlots({ settings: settings(), hours: [monday(540, 630)], busy: [], now: SUNDAY, });
    assert.deepEqual(starts(out).slice(0, 2), ["2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
    assert.equal(out.length, 2);
  });

  it("can fill the whole day up to 24:00", () => {
    const out = computeSlots({ settings: settings({ horizonDays: 2 }), hours: [monday(23 * 60, 1440)], busy: [], now: SUNDAY });
    assert.deepEqual(starts(out), ["2026-10-26T23:00:00.000Z"]);
  });

  it("drops a slot that has started or starts right now, and keeps the ones after", () => {
    const out = computeSlots({ settings: settings({ horizonDays: 2 }), hours: [monday(540, 720)], busy: [], now: at("2026-10-26T10:00:00Z") });
    assert.deepEqual(starts(out), ["2026-10-26T11:00:00.000Z"]);
  });

  it("stops at the end of the horizon, counting today as the first day", () => {
    const hours = [monday(540, 600)];
    assert.deepEqual(starts(computeSlots({ settings: settings({ horizonDays: 8 }), hours, busy: [], now: SUNDAY })), ["2026-10-26T09:00:00.000Z"]);
    assert.deepEqual(starts(computeSlots({ settings: settings({ horizonDays: 9 }), hours, busy: [], now: SUNDAY })), ["2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z"]);
  });

  it("leaves out a slot that overlaps a booking", () => {
    const out = computeSlots({ settings: settings({ horizonDays: 2 }), hours: [monday(540, 720)], busy: [busy("2026-10-26T10:00:00Z", "2026-10-26T11:00:00Z")], now: SUNDAY });
    assert.deepEqual(starts(out), ["2026-10-26T09:00:00.000Z", "2026-10-26T11:00:00.000Z"]);
  });

  it("keeps the buffer before and after a booking", () => {
    const wide = settings({ horizonDays: 2, bufferMinutes: 15 });
    const taken = [busy("2026-10-26T10:00:00Z", "2026-10-26T11:00:00Z")];
    assert.deepEqual(starts(computeSlots({ settings: wide, hours: [monday(540, 720)], busy: taken, now: SUNDAY })), [], "09:00 ends at the booking's start, 11:00 starts at its end: both inside the buffer");
    const wider = computeSlots({ settings: wide, hours: [monday(540, 840)], busy: taken, now: SUNDAY });
    assert.deepEqual(starts(wider), ["2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z"]);
    const exact = computeSlots({ settings: settings({ horizonDays: 2, slotMinutes: 30, bufferMinutes: 30 }), hours: [monday(540, 720)], busy: [busy("2026-10-26T10:00:00Z", "2026-10-26T10:30:00Z")], now: SUNDAY });
    assert.deepEqual(starts(exact), ["2026-10-26T09:00:00.000Z", "2026-10-26T11:00:00.000Z", "2026-10-26T11:30:00.000Z"], "a gap equal to the buffer is enough");
  });

  it("reads the hours in the zone of the settings", () => {
    const out = computeSlots({ settings: settings({ timezone: "America/Bogota", slotMinutes: 30, horizonDays: 3 }), hours: [monday(540, 600)], busy: [], now: SUNDAY });
    assert.deepEqual(starts(out), ["2026-10-26T14:00:00.000Z", "2026-10-26T14:30:00.000Z"]);
    const india = computeSlots({ settings: settings({ timezone: "Asia/Kolkata", horizonDays: 3 }), hours: [monday(540, 600)], busy: [], now: SUNDAY });
    assert.deepEqual(starts(india), ["2026-10-26T03:30:00.000Z"]);
  });

  it("counts today and the horizon by the date in the zone, not in UTC", () => {
    // 2026-10-26T02:00Z is still Sunday 21:00 in Bogota, so Monday is tomorrow and a one-day horizon holds nothing.
    const out = computeSlots({ settings: settings({ timezone: "America/Bogota", horizonDays: 1 }), hours: [monday(540, 600)], busy: [], now: at("2026-10-26T02:00:00Z") });
    assert.deepEqual(out, []);
  });

  it("skips the hour a spring clock change removes and does not shift the rest", () => {
    const sunday: Window = { weekday: 0, startMinute: 60, endMinute: 240 };
    const out = computeSlots({ settings: settings({ timezone: "America/New_York", slotMinutes: 30, horizonDays: 3 }), hours: [sunday], busy: [], now: at("2026-03-07T00:00:00Z") });
    assert.deepEqual(starts(out), ["2026-03-08T06:00:00.000Z", "2026-03-08T06:30:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z"]);
  });

  it("offers the repeated autumn hour once", () => {
    const sunday: Window = { weekday: 0, startMinute: 30, endMinute: 150 };
    const out = computeSlots({ settings: settings({ timezone: "America/New_York", horizonDays: 3 }), hours: [sunday], busy: [], now: at("2026-10-31T00:00:00Z") });
    const list = starts(out);
    assert.equal(new Set(list).size, list.length);
    assert.deepEqual(list, ["2026-11-01T04:30:00.000Z", "2026-11-01T05:30:00.000Z"]);
  });

  it("orders slots from several windows and days", () => {
    const hours: Window[] = [{ weekday: 2, startMinute: 600, endMinute: 660 }, monday(780, 840), monday(540, 600)];
    const list = starts(computeSlots({ settings: settings({ horizonDays: 3 }), hours, busy: [], now: SUNDAY }));
    assert.deepEqual(list, ["2026-10-26T09:00:00.000Z", "2026-10-26T13:00:00.000Z", "2026-10-27T10:00:00.000Z"]);
  });

  it("returns nothing when no window is set", () => {
    assert.deepEqual(computeSlots({ settings: settings(), hours: [], busy: [], now: SUNDAY }), []);
  });
});
