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

  it("marks the current item of a switcher whether the link says aria-current true or page", () => {
    assert.match(css, /\.au-seg a\[aria-current="true"\],\s*\.au-seg a\[aria-current="page"\]\s*\{/);
    assert.match(css, /\.au-seg a\[aria-current="page"\]::before/);
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
