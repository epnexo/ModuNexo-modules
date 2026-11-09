import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheHitRate, estimateCost, formatUsd, heatLevel, parsePrices, priceFor } from "../../modules/ai-usage/web/metrics.ts";

describe("cache hit rate", () => {
  it("is the share of input-side tokens served from the cache", () => {
    assert.equal(cacheHitRate({ inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 }), 0.8);
  });

  it("is null when the tool reports no cache reads, which is not the same as a 0% hit rate", () => {
    assert.equal(cacheHitRate({ inputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null }), null);
  });

  it("is 0 when the tool reports cache reads of zero, and null when nothing at all was counted", () => {
    assert.equal(cacheHitRate({ inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: null }), 0);
    assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
  });
});

describe("price table", () => {
  it("reads model=input/cacheRead/cacheWrite/output entries separated by semicolons or new lines", () => {
    const table = parsePrices("claude-a = 3/0.3/3.75/15; gpt-b=1.25/0.125/0/10\nmodel-c=1/0/0/2");
    assert.equal(table.ignored, 0);
    assert.deepEqual(priceFor(table, "claude-a"), { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 });
    assert.deepEqual(priceFor(table, "gpt-b"), { input: 1.25, cacheRead: 0.125, cacheWrite: 0, output: 10 });
    assert.equal(priceFor(table, "unknown"), null);
  });

  it("matches a trailing * as a prefix and prefers the exact entry, then the longest prefix", () => {
    const table = parsePrices("gpt-5*=1/0/0/1; gpt-5.6*=2/0/0/2; gpt-5.6-sol=9/0/0/9");
    assert.equal(priceFor(table, "gpt-5.4")!.input, 1);
    assert.equal(priceFor(table, "gpt-5.6-terra")!.input, 2);
    assert.equal(priceFor(table, "gpt-5.6-sol")!.input, 9);
  });

  it("counts the entries it cannot use instead of guessing, and never takes a negative or missing price", () => {
    const table = parsePrices("ok=1/1/1/1; broken; neg=-1/0/0/1; short=1/2/3; text=a/b/c/d; =1/1/1/1");
    assert.equal(table.ignored, 5);
    assert.deepEqual(table.entries.map((e) => e.pattern), ["ok"]);
  });

  it("is empty for a setting that is not set", () => {
    assert.deepEqual(parsePrices(null), { entries: [], ignored: 0 });
    assert.deepEqual(parsePrices(""), { entries: [], ignored: 0 });
  });
});

describe("estimated cost", () => {
  const table = parsePrices("m1=2/0.2/2.5/10");
  const row = (tool: string, model: string | null, input: number, cacheRead: number, cacheWrite: number, output: number) => ({ tool, model, inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output });

  it("prices every counter per million tokens and adds the tools up", () => {
    const estimate = estimateCost([row("a", "m1", 1_000_000, 10_000_000, 2_000_000, 500_000)], table);
    assert.equal(Math.round(estimate.cost * 1e6) / 1e6, 2 + 2 + 5 + 5);
    assert.equal(estimate.byTool.get("a"), estimate.cost);
  });

  it("leaves tokens of a model with no price out of the cost and reports how many", () => {
    const estimate = estimateCost([row("a", "m1", 1_000_000, 0, 0, 0), row("a", "mystery", 3_000_000, 0, 1_000_000, 0), row("b", null, 100, 0, 0, 0)], table);
    assert.equal(estimate.cost, 2);
    assert.equal(estimate.pricedTokens, 1_000_000);
    assert.equal(estimate.unpricedTokens, 4_000_100);
  });

  it("treats a counter the tool did not report as zero tokens", () => {
    const estimate = estimateCost([{ tool: "a", model: "m1", inputTokens: 1_000_000, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null }], table);
    assert.equal(estimate.cost, 2);
  });

  it("says nothing is priced when the table is empty", () => {
    const estimate = estimateCost([row("a", "m1", 5, 0, 0, 0)], parsePrices(""));
    assert.deepEqual([estimate.cost, estimate.pricedTokens, estimate.unpricedTokens], [0, 0, 5]);
  });
});

describe("formatUsd", () => {
  it("rounds to dollars above 100, to cents below, and uses thousands separators", () => {
    assert.equal(formatUsd(1234.56), "$1,235");
    assert.equal(formatUsd(12.345), "$12.35");
    assert.equal(formatUsd(0), "$0.00");
  });
});

describe("heat level", () => {
  it("puts zero at level 0 and the busiest cell at level 4, in between by share of the busiest", () => {
    assert.deepEqual([0, 1, 30, 60, 100].map((v) => heatLevel(v, 100)), [0, 1, 2, 3, 4]);
  });

  it("is 0 for everything when nothing was counted", () => {
    assert.equal(heatLevel(0, 0), 0);
  });
});
