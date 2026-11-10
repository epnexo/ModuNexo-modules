import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const css = readFileSync(new URL("../../modules/ai-usage/web/ai-usage.css", import.meta.url), "utf8");

// The tokens the platform defines in apps/web/src/styles/tokens.css; the page may use these without defining them.
const PLATFORM_TOKENS = new Set([
  "--background", "--surface", "--panel", "--panel-hover", "--foreground", "--muted-foreground", "--border", "--border-strong",
  "--accent", "--accent-hover", "--accent-foreground", "--accent-soft", "--accent-soft-foreground", "--danger", "--danger-soft",
  "--danger-soft-foreground", "--success", "--success-soft", "--warning", "--warning-soft", "--ring", "--shadow-raised",
  "--radius", "--font-sans", "--font-mono", "--duration-fast", "--duration", "--duration-slow", "--ease-out",
  "--layout-gap", "--card-pad", "--card-gap", "--card-radius",
]);

describe("ai-usage styles", () => {
  it("only uses design tokens that the platform or this stylesheet defines, so the page is never left unstyled", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]!));
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]!));
    const undefinedTokens = [...used].filter((name) => !defined.has(name) && !PLATFORM_TOKENS.has(name));
    assert.deepEqual(undefinedTokens, []);
  });

  it("leaves the switcher, figures, notices and tables to the platform: its pages use the platform classes and its css does not redefine them", () => {
    const web = new URL("../../modules/ai-usage/web/", import.meta.url);
    const markup = ["components.tsx", "panels.tsx", "daily-charts.tsx"].map((name) => readFileSync(new URL(name, web), "utf8")).join("\n");
    for (const platformClass of ["seg", "stats", "stat-value", "notice", "table-scroll", "data-table"]) {
      assert.match(markup, new RegExp(`className="[^"]*\\b${platformClass}\\b`), `a page uses ${platformClass}`);
    }
    assert.doesNotMatch(markup, /\bau-seg\b|\bkpi-value\b|\btable-wrap\b/, "no page keeps an old class");
    assert.doesNotMatch(css, /(^|[\s,}])(\.au-seg|\.au \.kpis|\.au \.kpi(?![-\w])|\.au \.notice|\.au \.table-wrap|\.au table|\.au th|\.au td)\b/m, "the css does not restyle what the platform owns");
  });

  it("turns the bar animation off for anyone who asked for less motion", () => {
    assert.match(css, /\.au-bar\s*\{[^}]*animation:\s*au-grow/);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.au-bar\s*\{[^}]*animation:\s*none/);
    assert.ok(reduced, "a reduced-motion rule sets .au-bar animation to none");
  });

  it("takes spacing from the platform variables, with a fallback for an older platform", () => {
    for (const [own, platform] of [["--grid-gap", "--layout-gap"], ["--portlet-pad", "--card-pad"], ["--au-radius", "--card-radius"]] as const) {
      assert.match(css, new RegExp(`${own}:\\s*var\\(${platform},\\s*[^)]+\\)`), `${own} reads ${platform}`);
    }
  });
});
