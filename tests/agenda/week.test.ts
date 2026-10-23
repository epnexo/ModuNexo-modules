import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDay, weekOf } from "../../agenda/lib/week.ts";

const NOW = new Date("2026-10-25T15:00:00Z"); // a Sunday afternoon in UTC

describe("parseDay", () => {
  it("reads YYYY-MM-DD and refuses anything else, including dates that do not exist", () => {
    assert.deepEqual(parseDay("2026-10-26"), { year: 2026, month: 10, day: 26 });
    for (const bad of [undefined, "", "2026-10-2", "26-10-2026", "2026-13-01", "2026-02-30", "2026-10-26T00:00", "today", ["2026-10-26"]]) assert.equal(parseDay(bad as never), null, String(bad));
  });
});

describe("weekOf", () => {
  it("is the Monday-to-Sunday week that holds the day asked for", () => {
    const week = weekOf("2026-10-28", NOW, "UTC");
    assert.deepEqual(week.days.map((d) => d.day), [26, 27, 28, 29, 30, 31, 1]);
    assert.deepEqual(week.days.map((d) => d.month), [10, 10, 10, 10, 10, 10, 11]);
    assert.equal(week.from.toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(week.to.toISOString(), "2026-11-02T00:00:00.000Z");
  });

  it("puts a Sunday in the week that started the Monday before, and a Monday in its own week", () => {
    assert.equal(weekOf("2026-11-01", NOW, "UTC").from.toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(weekOf("2026-10-26", NOW, "UTC").from.toISOString(), "2026-10-26T00:00:00.000Z");
  });

  it("defaults to the week of today in the agenda's zone, also when the day is invalid", () => {
    assert.equal(weekOf(undefined, NOW, "UTC").from.toISOString(), "2026-10-19T00:00:00.000Z");
    assert.equal(weekOf("nonsense", NOW, "UTC").from.toISOString(), "2026-10-19T00:00:00.000Z");
    // 2026-10-26T02:00Z is still Sunday 21:00 in Bogota: the week is the one before.
    assert.equal(weekOf(undefined, new Date("2026-10-26T02:00:00Z"), "America/Bogota").days[0]!.day, 19);
  });

  it("gives the neighbouring weeks as day parameters, across a year end", () => {
    const week = weekOf("2026-12-30", NOW, "UTC");
    assert.equal(week.prev, "2026-12-21");
    assert.equal(week.next, "2027-01-04");
    assert.deepEqual(week.days.map((d) => [d.year, d.month, d.day]).at(-1), [2027, 1, 3]);
  });

  it("measures the range in the zone: Monday 00:00 in Bogota is 05:00 UTC", () => {
    const week = weekOf("2026-10-26", NOW, "America/Bogota");
    assert.equal(week.from.toISOString(), "2026-10-26T05:00:00.000Z");
    assert.equal(week.to.toISOString(), "2026-11-02T05:00:00.000Z");
  });

  it("is not a fixed 168 hours: the week that holds the autumn clock change is an hour longer", () => {
    const week = weekOf("2026-10-28", NOW, "America/New_York"); // the clocks go back on Sunday 1 November
    assert.equal(week.from.toISOString(), "2026-10-26T04:00:00.000Z", "Monday 00:00 EDT");
    assert.equal(week.to.toISOString(), "2026-11-02T05:00:00.000Z", "Monday 00:00 EST");
    assert.equal((week.to.getTime() - week.from.getTime()) / 3_600_000, 169);
    assert.equal(weekOf("2026-11-02", NOW, "America/New_York").from.toISOString(), "2026-11-02T05:00:00.000Z");
  });
});
