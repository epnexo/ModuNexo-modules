import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketDaily, bucketSeries, bucketStart, bucketTitle, parseGrain } from "../../modules/ai-usage/web/buckets.ts";
import { withFilters } from "../../modules/ai-usage/web/filters.ts";

describe("parseGrain", () => {
  it("accepts day, week and month and falls back to day for anything else", () => {
    assert.equal(parseGrain("week"), "week");
    assert.equal(parseGrain("month"), "month");
    assert.equal(parseGrain(["week", "month"]), "week");
    for (const bad of [undefined, "", "year", "WEEK", "week; drop"]) assert.equal(parseGrain(bad), "day");
  });
});

describe("bucketStart", () => {
  it("keeps a day, moves a week to its Monday and a month to its first day (UTC)", () => {
    assert.equal(bucketStart("2026-11-09", "day"), "2026-11-09");
    assert.equal(bucketStart("2026-11-09", "week"), "2026-11-09"); // a Monday
    assert.equal(bucketStart("2026-11-15", "week"), "2026-11-09"); // the Sunday of that week
    assert.equal(bucketStart("2026-11-16", "week"), "2026-11-16");
    assert.equal(bucketStart("2026-01-01", "week"), "2025-12-29"); // crosses the year
    assert.equal(bucketStart("2026-11-30", "month"), "2026-11-01");
  });
});

describe("bucketSeries", () => {
  it("lists every bucket from the one holding `from` to the one holding `to`, so quiet buckets stay as gaps", () => {
    assert.deepEqual(bucketSeries("2026-11-01", "2026-11-03", "day"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
    assert.deepEqual(bucketSeries("2026-11-05", "2026-11-24", "week"), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
    assert.deepEqual(bucketSeries("2026-10-31", "2026-12-02", "month"), ["2026-10-01", "2026-11-01", "2026-12-01"]);
  });
});

describe("bucketDaily", () => {
  const rows = [
    { day: "2026-11-02", tool: "codex", totalTokens: 10 },
    { day: "2026-11-08", tool: "codex", totalTokens: 5 },
    { day: "2026-11-09", tool: "codex", totalTokens: 7 },
    { day: "2026-11-09", tool: "pi", totalTokens: 3 },
  ];
  it("returns the rows unchanged for days", () => {
    assert.deepEqual(bucketDaily(rows, "day"), rows);
  });
  it("sums the tokens of a tool inside each week and month and keeps tools apart", () => {
    assert.deepEqual(bucketDaily(rows, "week"), [
      { day: "2026-11-02", tool: "codex", totalTokens: 15 },
      { day: "2026-11-09", tool: "codex", totalTokens: 7 },
      { day: "2026-11-09", tool: "pi", totalTokens: 3 },
    ]);
    assert.deepEqual(bucketDaily(rows, "month"), [
      { day: "2026-11-01", tool: "codex", totalTokens: 22 },
      { day: "2026-11-01", tool: "pi", totalTokens: 3 },
    ]);
  });
});

describe("bucketTitle", () => {
  it("names the week by its first day and the month by its name", () => {
    assert.match(bucketTitle("2026-11-09", "week"), /^Week of .*9 Nov 2026/);
    assert.equal(bucketTitle("2026-11-01", "month"), "Nov 2026");
    assert.match(bucketTitle("2026-11-09", "day"), /9 Nov 2026/);
  });
});

describe("withFilters keeps the interval", () => {
  it("adds grain only when it is not daily and keeps it when the period changes", () => {
    const current = { period: "30d" as const, tool: null, grain: "week" as const };
    assert.equal(withFilters(current, {}, "/ai-usage"), "/ai-usage?grain=week");
    assert.equal(withFilters(current, { period: "90d" }, "/ai-usage"), "/ai-usage?period=90d&grain=week");
    assert.equal(withFilters(current, { grain: "day" }, "/ai-usage"), "/ai-usage");
    assert.equal(withFilters({ period: "30d", tool: null }, {}, "/ai-usage"), "/ai-usage");
  });
});
