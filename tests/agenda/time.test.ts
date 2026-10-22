import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, isTimeZone, localToUtc, weekdayOf, zonedParts } from "../../agenda/lib/time.ts";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("isTimeZone", () => {
  it("accepts an IANA zone and refuses anything else", () => {
    assert.equal(isTimeZone("America/Bogota"), true);
    assert.equal(isTimeZone("UTC"), true);
    for (const name of ["Mars/Base", "", "  ", "bogota", "GMT+5x"]) assert.equal(isTimeZone(name), false, name);
  });
});

describe("zonedParts", () => {
  it("reads the local date, time and weekday of an instant in a zone", () => {
    assert.deepEqual(zonedParts(Date.UTC(2026, 9, 23, 14, 0), "America/Bogota"), { year: 2026, month: 10, day: 23, minuteOfDay: 9 * 60, weekday: 5 });
    assert.deepEqual(zonedParts(Date.UTC(2026, 9, 23, 22, 30), "Asia/Kolkata"), { year: 2026, month: 10, day: 24, minuteOfDay: 4 * 60, weekday: 6 });
  });
});

describe("localToUtc", () => {
  it("turns a local time into an instant, with a zone behind UTC and one ahead", () => {
    assert.equal(iso(localToUtc(2026, 10, 23, 9 * 60, "America/Bogota")), "2026-10-23T14:00:00.000Z");
    assert.equal(iso(localToUtc(2026, 10, 23, 9 * 60, "Asia/Kolkata")), "2026-10-23T03:30:00.000Z");
    assert.equal(iso(localToUtc(2026, 10, 23, 9 * 60, "UTC")), "2026-10-23T09:00:00.000Z");
  });

  it("follows daylight saving: before and after the spring change in New York", () => {
    assert.equal(iso(localToUtc(2026, 3, 8, 90, "America/New_York")), "2026-03-08T06:30:00.000Z"); // 01:30 EST
    assert.equal(iso(localToUtc(2026, 3, 8, 3 * 60 + 30, "America/New_York")), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
  });

  it("returns null for a local time that does not exist (the hour skipped in spring)", () => {
    assert.equal(localToUtc(2026, 3, 8, 2 * 60 + 30, "America/New_York"), null);
  });

  it("takes the earlier instant for a local time that happens twice (the hour repeated in autumn)", () => {
    assert.equal(iso(localToUtc(2026, 11, 1, 90, "America/New_York")), "2026-11-01T05:30:00.000Z"); // 01:30 EDT, the first
    assert.equal(iso(localToUtc(2026, 11, 1, 2 * 60 + 30, "America/New_York")), "2026-11-01T07:30:00.000Z"); // 02:30 EST
  });

  it("round-trips through zonedParts for every half hour of a day with a change", () => {
    for (let minute = 0; minute < 24 * 60; minute += 30) {
      const at = localToUtc(2026, 3, 8, minute, "America/New_York");
      if (at === null) continue;
      assert.equal(zonedParts(at, "America/New_York").minuteOfDay, minute, String(minute));
    }
  });
});

describe("addDays and weekdayOf", () => {
  it("moves a calendar date across months, years and a leap day", () => {
    assert.deepEqual(addDays(2026, 12, 31, 1), { year: 2027, month: 1, day: 1 });
    assert.deepEqual(addDays(2028, 2, 28, 1), { year: 2028, month: 2, day: 29 });
    assert.deepEqual(addDays(2026, 3, 1, -1), { year: 2026, month: 2, day: 28 });
    assert.deepEqual(addDays(2026, 10, 23, 0), { year: 2026, month: 10, day: 23 });
  });

  it("gives the weekday with Sunday as 0", () => {
    assert.equal(weekdayOf(2026, 10, 25), 0);
    assert.equal(weekdayOf(2026, 10, 23), 5);
    assert.equal(weekdayOf(2026, 10, 24), 6);
  });
});
