import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../modules/ai-usage/web", import.meta.url));
const SVG_TAGS = new Set(["svg", "g", "rect", "line", "path", "circle", "text", "clipPath", "defs", "stop", "linearGradient"]);

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n"));

/** The `au-*` class names written as string literals (plain, template or in a ternary) that each element of the module's components carries, split into SVG marks and everything else. */
function classesByKind(): { svg: Set<string>; html: Set<string> } {
  const svg = new Set<string>();
  const html = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const m of source.matchAll(/<([A-Za-z][\w.]*)\b[^<>]*?\bclassName=(?:"([^"]*)"|\{"([^"]*)"\}|\{`([^`]*)`\}|\{([^{}`]*)\})/g)) {
      const value = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").replace(/\$\{[^}]*\}/g, " ");
      for (const token of value.match(/\bau-[\w-]+/g) ?? []) (SVG_TAGS.has(m[1]!) ? svg : html).add(token);
    }
  }
  return { svg, html };
}

/** True when every rule that mentions the class declares nothing but custom properties, so it cannot restyle either side. */
function onlyCustomProperties(name: string): boolean {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => new RegExp(`\\.${name}(?![\\w-])`).test(m[1]!));
  return rules.length > 0 && rules.every((m) => m[2]!.split(";").map((d) => d.trim()).filter(Boolean).every((d) => d.startsWith("--")));
}

describe("module stylesheet class names", () => {
  it("finds the SVG marks and the HTML elements it is meant to compare", () => {
    const { svg, html } = classesByKind();
    assert.ok(svg.has("au-bar") && svg.has("au-grid"), [...svg].join(" "));
    assert.ok(html.has("au-seg") && html.has("au-tip"), [...html].join(" "));
  });

  it("never applies one class name to both an SVG mark and an HTML element, unless it only sets custom properties", () => {
    const { svg, html } = classesByKind();
    const shared = [...svg].filter((name) => html.has(name) && !onlyCustomProperties(name));
    assert.deepEqual(shared, []);
  });

  it("keeps the filter control and the stacked bar segments on their own names", () => {
    assert.match(css, /\.au-seg\s*{[^}]*display:\s*inline-flex/);
    assert.match(css, /\.au-bar\s*{[^}]*fill:/);
    assert.doesNotMatch(css, /\.au-seg\s*{[^}]*fill:/);
  });
});
