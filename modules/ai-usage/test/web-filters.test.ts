import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PERIOD, parseFilters, periodStart, toolColorSlot, withFilters } from "../web/filters.ts";

const TOOLS = ["claude-code", "codex", "pi", "opencode"];

describe("parseFilters", () => {
  it("falls back to the defaults when nothing is given", () => {
    assert.deepEqual(parseFilters({}, TOOLS), { period: DEFAULT_PERIOD, tool: null, problems: [] });
  });

  it("accepts known periods and tools", () => {
    assert.deepEqual(parseFilters({ period: "7d", tool: "codex" }, TOOLS), { period: "7d", tool: "codex", problems: [] });
    assert.equal(parseFilters({ period: "all" }, TOOLS).period, "all");
  });

  it("rejects unknown values, uses the defaults and reports each problem", () => {
    const parsed = parseFilters({ period: "1y", tool: "emacs" }, TOOLS);
    assert.equal(parsed.period, DEFAULT_PERIOD);
    assert.equal(parsed.tool, null);
    assert.equal(parsed.problems.length, 2);
    assert.match(parsed.problems[0]!, /1y/);
    assert.match(parsed.problems[1]!, /emacs/);
  });

  it("uses the first value when a parameter is repeated and ignores empty ones", () => {
    assert.equal(parseFilters({ period: ["90d", "7d"] }, TOOLS).period, "90d");
    assert.deepEqual(parseFilters({ period: "", tool: "" }, TOOLS).problems, []);
  });
});

describe("periodStart", () => {
  const now = new Date("2026-10-07T03:00:00Z");

  it("counts today as the last day of the window, in UTC", () => {
    assert.equal(periodStart("7d", now), "2026-10-01");
    assert.equal(periodStart("30d", now), "2026-09-08");
    assert.equal(periodStart("90d", now), "2026-07-10");
  });

  it("has no lower bound for all", () => {
    assert.equal(periodStart("all", now), null);
  });
});

describe("withFilters", () => {
  it("builds a shareable query string and omits default values", () => {
    assert.equal(withFilters({ period: DEFAULT_PERIOD, tool: null }, {}), "/ai-usage");
    assert.equal(withFilters({ period: "7d", tool: "codex" }, {}), "/ai-usage?period=7d&tool=codex");
    assert.equal(withFilters({ period: "7d", tool: "codex" }, { tool: null }), "/ai-usage?period=7d");
    assert.equal(withFilters({ period: "7d", tool: null }, { period: DEFAULT_PERIOD }), "/ai-usage");
  });
});

describe("toolColorSlot", () => {
  it("keeps each known tool on its own slot regardless of which tools are shown", () => {
    assert.equal(toolColorSlot("claude-code", TOOLS), 1);
    assert.equal(toolColorSlot("codex", TOOLS), 2);
    assert.equal(toolColorSlot("pi", ["pi"]), 3);
    assert.equal(toolColorSlot("opencode", ["opencode"]), 4);
  });

  it("gives future tools the next free slots in order and folds the rest to neutral", () => {
    const all = [...TOOLS, "gemini", "aider", "x1", "x2", "x3", "x4"];
    assert.equal(toolColorSlot("gemini", all), 5);
    assert.equal(toolColorSlot("aider", all), 6);
    assert.equal(toolColorSlot("x3", all), 0);
  });
});
