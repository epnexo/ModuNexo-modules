import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReference } from "../src/reference.ts";

describe("formatReference", () => {
  it("writes PREFIX-YYYY-NNN with three digits at least", () => {
    assert.equal(formatReference("NDA", 2026, 1), "NDA-2026-001");
    assert.equal(formatReference("NDA", 2026, 42), "NDA-2026-042");
    assert.equal(formatReference("CON1", 2027, 999), "CON1-2027-999");
  });

  it("grows past 999 instead of wrapping or truncating", () => {
    assert.equal(formatReference("NDA", 2026, 1000), "NDA-2026-1000");
    assert.equal(formatReference("NDA", 2026, 123456), "NDA-2026-123456");
  });

  it("refuses a number that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => formatReference("NDA", 2026, bad), RangeError, String(bad));
    }
  });

  it("refuses a prefix or a year that could not be part of a reference or a file name", () => {
    for (const prefix of ["", "nda", "N-A", "N A", "NDA/..", "ABCDEFGHIJK", "ÑDA"]) assert.throws(() => formatReference(prefix, 2026, 1), RangeError, prefix);
    for (const year of [0, 99, 10000, 2026.5, Number.NaN]) assert.throws(() => formatReference("NDA", year, 1), RangeError, String(year));
  });
});
