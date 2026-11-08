import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupModels } from "../web/group.ts";
import type { ModelRow } from "../web/queries.ts";

const row = (model: string | null, tool: string, totalTokens: number, sessions: number): ModelRow => ({ model, tool, totalTokens, sessions });

describe("groupModels", () => {
  it("merges a model served through several tools into one row, largest first", () => {
    const { models, other } = groupModels(
      [row("m1", "claude-code", 300, 2), row("m2", "codex", 500, 1), row("m1", "codex", 100, 1)],
      10,
    );
    assert.equal(other, null);
    assert.deepEqual(
      models.map((m) => [m.model, m.totalTokens, m.sessions]),
      [
        ["m2", 500, 1],
        ["m1", 400, 3],
      ],
    );
    assert.deepEqual(models[1]!.tools, [
      { tool: "claude-code", totalTokens: 300 },
      { tool: "codex", totalTokens: 100 },
    ]);
  });

  it("keeps rows without a model together under null", () => {
    const { models } = groupModels([row(null, "pi", 0, 1), row(null, "codex", 4, 1)], 10);
    assert.equal(models.length, 1);
    assert.equal(models[0]!.model, null);
    assert.equal(models[0]!.totalTokens, 4);
  });

  it("folds the tail beyond the limit into a single summary", () => {
    const rows = [row("a", "t", 50, 1), row("b", "t", 30, 1), row("c", "t", 15, 2), row("d", "t", 5, 1)];
    const { models, other } = groupModels(rows, 2);
    assert.deepEqual(models.map((m) => m.model), ["a", "b"]);
    assert.deepEqual(other, { count: 2, totalTokens: 20 });
  });

  it("returns an empty result for no rows", () => {
    assert.deepEqual(groupModels([], 5), { models: [], other: null });
  });
});
