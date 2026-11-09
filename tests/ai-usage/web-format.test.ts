import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOT_AVAILABLE, formatCompact, formatAgo, formatCount, formatPercent, formatUtcDay, formatUtcDayShort, formatUtcMinute } from "../../modules/ai-usage/web/format.ts";

describe("formatCompact", () => {
  it("uses three significant digits and trims trailing zeros", () => {
    assert.equal(formatCompact(1_070_039_431), "1.07B");
    assert.equal(formatCompact(392_486_355), "392M");
    assert.equal(formatCompact(76_107_288), "76.1M");
    assert.equal(formatCompact(3_460_000), "3.46M");
    assert.equal(formatCompact(1_000_000_000), "1B");
    assert.equal(formatCompact(12_345), "12.3K");
  });

  it("prints small values as plain integers", () => {
    assert.equal(formatCompact(0), "0");
    assert.equal(formatCompact(7), "7");
    assert.equal(formatCompact(999), "999");
  });

  it("carries into the next unit instead of printing 1000K", () => {
    assert.equal(formatCompact(999_960), "1M");
    assert.equal(formatCompact(999_999_999), "1B");
  });

  it("never turns an unknown value into zero", () => {
    assert.equal(formatCompact(null), NOT_AVAILABLE);
    assert.equal(formatCount(null), NOT_AVAILABLE);
    assert.equal(formatPercent(null), NOT_AVAILABLE);
  });
});

describe("formatCount", () => {
  it("groups thousands with a fixed locale", () => {
    assert.equal(formatCount(1_070_039_431), "1,070,039,431");
    assert.equal(formatCount(0), "0");
  });
});

describe("formatPercent", () => {
  it("shows one decimal under 10 percent and none above", () => {
    assert.equal(formatPercent(0.0537), "5.4%");
    assert.equal(formatPercent(0.951), "95%");
    assert.equal(formatPercent(1), "100%");
    assert.equal(formatPercent(0), "0%");
  });

  it("flags non-zero shares that would round to zero", () => {
    assert.equal(formatPercent(0.00004), "<0.1%");
  });
});

describe("UTC date formatting", () => {
  it("renders days and minutes in UTC regardless of the server time zone", () => {
    assert.equal(formatUtcDay("2026-10-07"), "7 Oct 2026");
    assert.equal(formatUtcMinute(new Date("2026-10-07T23:59:30Z")), "2026-10-07 23:59");
  });
});

describe("formatUtcDayShort", () => {
  it("drops the year for crowded axis labels", () => {
    assert.equal(formatUtcDayShort("2026-10-07"), "7 Oct");
    assert.equal(formatUtcDayShort("2026-01-31"), "31 Jan");
  });

  it("returns the input when it is not a date", () => {
    assert.equal(formatUtcDayShort("soon"), "soon");
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const ago = (ms: number) => formatAgo(new Date(now.getTime() - ms), now);
  it("says how long ago in the largest whole unit", () => {
    assert.equal(ago(20_000), "just now");
    assert.equal(ago(5 * 60_000), "5 min ago");
    assert.equal(ago(3 * 3_600_000 + 1_000), "3 h ago");
    assert.equal(ago(2 * 86_400_000), "2 days ago");
    assert.equal(ago(86_400_000 + 1), "1 day ago");
  });
  it("never shows a negative age when the clocks differ a little", () => {
    assert.equal(formatAgo(new Date(now.getTime() + 5_000), now), "just now");
  });
});
