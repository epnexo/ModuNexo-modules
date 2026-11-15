import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sparkPoints } from "../../modules/observability/lib/spark.ts";

describe("sparkPoints", () => {
  it("needs at least two values to draw a line", () => {
    assert.equal(sparkPoints([], 100, 20), "");
    assert.equal(sparkPoints([5], 100, 20), "");
  });

  it("spreads the values across the width and scales them to the height, high values at the top", () => {
    assert.equal(sparkPoints([0, 50, 100], 100, 20), "0,18 50,10 100,2");
  });

  it("draws a flat series in the middle", () => {
    assert.equal(sparkPoints([7, 7, 7], 100, 20), "0,10 50,10 100,10");
  });

  it("uses a fixed 0 to max scale when asked, so 50% is half way whatever the series holds", () => {
    assert.equal(sparkPoints([50, 50], 100, 20, 100), "0,10 100,10");
    assert.equal(sparkPoints([0, 100], 100, 20, 100), "0,18 100,2");
  });
});
