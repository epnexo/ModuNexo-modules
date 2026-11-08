import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageBar } from "../web/nav.tsx";
import { DOCUMENTS_CSS } from "../web/styles.ts";

const webDir = join(import.meta.dirname, "..", "web");

/** Every class a page writes as a literal, plus the ones the status badges and KPI cards build. */
function usedClasses(): Set<string> {
  const used = new Set<string>(["badge", "ok", "warn", "error", "kpi-1", "kpi-2", "kpi-3", "kpi-4"]);
  for (const file of readdirSync(webDir).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(join(webDir, file), "utf8");
    for (const match of source.matchAll(/className="([^"]*)"/g)) for (const name of match[1]!.split(/\s+/).filter(Boolean)) used.add(name);
    for (const match of source.matchAll(/"(field wide|field)"/g)) for (const name of match[1]!.split(" ")) used.add(name);
  }
  return used;
}

test("every class the pages use is defined by the module's stylesheet, because the platform does not know them", () => {
  const defined = new Set([...DOCUMENTS_CSS.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]!));
  // `kpi-N` only varies by position and carries no rule of its own.
  const missing = [...usedClasses()].filter((name) => !defined.has(name) && !/^kpi-\d$/.test(name));
  assert.deepEqual(missing, []);
});

test("the page bar carries the stylesheet, so every page that has one is styled", () => {
  const html = renderToStaticMarkup(PageBar({ title: "Documents", current: "documents" }));
  assert.match(html, /<style>[\s\S]*\.portlet[\s\S]*<\/style>/);
  assert.match(html, /class="page-bar"/);
});

test("the stylesheet takes its colors from the platform tokens, not from values of its own", () => {
  assert.doesNotMatch(DOCUMENTS_CSS, /#[0-9a-f]{3,8}\b|rgb\(|oklch\(|hsl\(/i);
});
