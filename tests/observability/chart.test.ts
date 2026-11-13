import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { axisTicks, nearestIndex, niceCeiling, plot, timeTicks } from "../../modules/observability/lib/chart.ts";
import { RANGES, parseRange } from "../../modules/observability/lib/ranges.ts";

const box = { width: 100, height: 50, from: 0, to: 20, max: 100 };

describe("axis helpers", () => {
  it("rounds a maximum up to a round ceiling", () => {
    assert.deepEqual([niceCeiling(0), niceCeiling(37), niceCeiling(100), niceCeiling(101)], [1, 50, 100, 200]);
  });

  it("puts at most five round intervals on an axis", () => {
    assert.deepEqual(axisTicks(100), { max: 100, ticks: [0, 20, 40, 60, 80, 100] });
    assert.deepEqual(axisTicks(37), { max: 50, ticks: [0, 10, 20, 30, 40, 50] });
  });

  it("spreads time ticks evenly from the first to the last instant", () => {
    assert.deepEqual(timeTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  });
});

describe("plot", () => {
  const point = (t: number, value: number, min = value, max = value) => ({ t, avg: value, min, max });

  it("maps time to x and value to y on a shared baseline at the bottom", () => {
    const drawn = plot([point(0, 20), point(10, 60), point(20, 100)], { ...box, gapMs: 15 });
    assert.equal(drawn.line, "M0 40L50 20L100 0");
    assert.deepEqual(drawn.dots.map((dot) => [dot.x, dot.y]), [[0, 40], [50, 20], [100, 0]]);
  });

  it("breaks the line where the host sent nothing for longer than the gap", () => {
    const drawn = plot([point(0, 20), point(10, 60), point(50, 100)], { ...box, to: 50, gapMs: 15 });
    assert.equal(drawn.line, "M0 40L20 20M100 0");
  });

  it("draws the min-max band only for a run of two or more points that really spread", () => {
    const flat = plot([point(0, 20), point(10, 60)], { ...box, gapMs: 15 });
    assert.equal(flat.band, "");
    const wide = plot([point(0, 40, 20, 60), point(20, 40, 20, 60)], { ...box, gapMs: 25 });
    assert.equal(wide.band, "M0 20L100 20L100 40L0 40Z");
  });

  it("keeps values above the axis maximum inside the plot", () => {
    assert.equal(plot([point(0, 250), point(20, 250)], { ...box, gapMs: 25 }).line, "M0 0L100 0");
  });

  it("draws nothing for no points", () => {
    assert.deepEqual(plot([], { ...box, gapMs: 10 }), { line: "", band: "", dots: [] });
  });
});

describe("nearestIndex", () => {
  it("returns the closest point to a pointer position, or -1 with no points", () => {
    assert.equal(nearestIndex([0, 20, 100], 30), 1);
    assert.equal(nearestIndex([0, 20, 100], 70), 2);
    assert.equal(nearestIndex([], 5), -1);
  });
});

describe("ranges", () => {
  it("knows where each range reads from and how wide its steps are", () => {
    assert.deepEqual(Object.keys(RANGES), ["1h", "24h", "7d", "30d", "90d"]);
    assert.equal(RANGES["1h"].source, "raw");
    assert.equal(RANGES["7d"].source, "hourly");
    assert.equal(RANGES["90d"].source, "daily");
  });

  it("falls back to 24h for anything it does not know", () => {
    assert.deepEqual([parseRange("7d"), parseRange("bogus"), parseRange(undefined), parseRange(["1h"])], ["7d", "24h", "24h", "24h"]);
  });
});
