import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureRate, KNOWN_TOOLS, mergeSkills, overviewTools, profileOf, toolPageHref } from "../../modules/ai-usage/web/tools.ts";
import { withFilters } from "../../modules/ai-usage/web/filters.ts";

describe("tool profiles", () => {
  it("knows the four CLIs, each with a name and how its skills are found", () => {
    assert.deepEqual(KNOWN_TOOLS.map((t) => [t.slug, t.name, t.skills]), [
      ["claude-code", "Claude Code", "exact"],
      ["codex", "Codex", "estimated"],
      ["opencode", "OpenCode", "exact"],
      ["pi", "Pi", "estimated"],
    ]);
  });

  it("falls back to a neutral profile for a tool it does not know", () => {
    assert.deepEqual(profileOf("zed"), { slug: "zed", name: "zed", tagline: "", skills: "none", known: false });
    assert.equal(profileOf("zed", "Zed").name, "Zed");
    assert.equal(profileOf("codex", "Whatever").name, "Whatever", "the name stored by the collector wins");
  });

  it("lists the four CLIs first even when nothing was sent for some, then any other stored tool", () => {
    const tools = overviewTools([
      { slug: "codex", name: "Codex" },
      { slug: "zed", name: "Zed" },
      { slug: "claude-code", name: "Claude Code" },
    ]);
    assert.deepEqual(tools.map((t) => t.slug), ["claude-code", "codex", "opencode", "pi", "zed"]);
    assert.equal(tools.find((t) => t.slug === "pi")!.name, "Pi");
  });
});

describe("tool page links", () => {
  it("points at the tool's own page and keeps the period only when it is not the default", () => {
    assert.equal(toolPageHref("claude-code", "30d"), "/ai-usage/claude-code");
    assert.equal(toolPageHref("codex", "7d"), "/ai-usage/codex?period=7d");
    assert.equal(toolPageHref("a b", "all"), "/ai-usage/a%20b?period=all");
  });

  it("builds period links for a tool page from that page's own path", () => {
    assert.equal(withFilters({ period: "30d", tool: null }, { period: "90d" }, "/ai-usage/codex"), "/ai-usage/codex?period=90d");
    assert.equal(withFilters({ period: "7d", tool: null }, { period: "30d" }, "/ai-usage/codex"), "/ai-usage/codex");
  });
});

describe("merging skills across tools", () => {
  const rows = [
    { tool: "claude-code", skill: "alpha", calls: 3, sessions: 1 },
    { tool: "codex", skill: "alpha", calls: 2, sessions: 1 },
    { tool: "claude-code", skill: "beta", calls: 1, sessions: 1 },
  ];

  it("adds the calls of one skill used through several tools and lists those tools", () => {
    const merged = mergeSkills(rows, 10);
    assert.deepEqual(merged.map((m) => [m.skill, m.calls, m.sessions, m.tools]), [
      ["alpha", 5, 2, ["claude-code", "codex"]],
      ["beta", 1, 1, ["claude-code"]],
    ]);
  });

  it("marks a skill as estimated when any of its calls came from a tool that has no skill event", () => {
    const merged = mergeSkills(rows, 10);
    assert.deepEqual(merged.map((m) => m.estimated), [true, false]);
  });

  it("keeps only the requested number, most used first", () => {
    assert.deepEqual(mergeSkills(rows, 1).map((m) => m.skill), ["alpha"]);
  });
});

describe("failure rate", () => {
  it("is the share of failed calls among the calls whose outcome the log reports", () => {
    assert.equal(failureRate({ calls: 10, failed: 1, reported: 4 }), 0.25);
  });

  it("is null when the log never reports an outcome, which is not the same as no failures", () => {
    assert.equal(failureRate({ calls: 5, failed: 0, reported: 0 }), null);
  });
});
