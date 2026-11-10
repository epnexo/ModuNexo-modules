import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageBar } from "../web/nav.tsx";

const webDir = join(import.meta.dirname, "..", "web");
const css = readFileSync(join(webDir, "documents.css"), "utf8");
const sources = readdirSync(webDir).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts")).map((name) => readFileSync(join(webDir, name), "utf8"));

/** Every class the pages write as a literal. */
const used = new Set(sources.flatMap((source) => [...source.matchAll(/className="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/).filter(Boolean))));
/** Every class the module's own stylesheet defines. */
const defined = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]!));

test("the module's own classes carry its prefix and every one a page uses is defined in its stylesheet", () => {
  const own = [...used].filter((name) => name.startsWith("dc-"));
  assert.deepEqual(own.filter((name) => !defined.has(name)), []);
  assert.deepEqual([...defined].filter((name) => !name.startsWith("dc-")), [], "the stylesheet defines only classes with the module's prefix");
});

test("the stylesheet has no class that no page uses", () => {
  assert.deepEqual([...defined].filter((name) => !used.has(name)), []);
});

test("the pages use the platform's components, not the names the module used to define itself", () => {
  for (const old of ["portlet", "portlet-head", "portlet-body", "portlet-note", "kpis", "kpi", "page-body", "page-bar", "page-tabs", "table-wrap", "primary", "muted", "num"]) {
    assert.ok(!used.has(old), `a page still uses the old class ${old}`);
  }
  for (const platform of ["card", "stats", "stat", "stat-label", "stat-value", "data-table", "table-scroll", "btn", "btn-primary", "input", "field", "form", "badge", "notice", "seg", "detail-list"]) {
    assert.ok(used.has(platform) || sources.some((source) => source.includes(platform)), `the pages use ${platform}`);
  }
});

test("the page bar no longer injects a stylesheet of its own: the css is imported by the pages", () => {
  const html = renderToStaticMarkup(PageBar({ title: "Documents", current: "documents" }));
  assert.doesNotMatch(html, /<style/);
  assert.match(html, /class="dc-bar"/);
  assert.match(html, /class="seg"/);
});

test("the stylesheet takes its colors from the platform tokens, not from values of its own", () => {
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,8}\b|rgb\(|oklch\(|hsl\(/i);
});
