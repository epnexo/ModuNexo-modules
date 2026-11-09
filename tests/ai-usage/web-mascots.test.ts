import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MASCOT_SLUGS, Mascot } from "../../modules/ai-usage/web/mascots.tsx";
import { KNOWN_TOOLS } from "../../modules/ai-usage/web/tools.ts";

const css = readFileSync(fileURLToPath(new URL("../../modules/ai-usage/web/ai-usage.css", import.meta.url)), "utf8");
const draw = (slug: string) => renderToStaticMarkup(createElement(Mascot, { slug }));

describe("mascots", () => {
  it("has its own drawing for every CLI the module knows", () => {
    assert.deepEqual([...MASCOT_SLUGS].sort(), KNOWN_TOOLS.map((t) => t.slug).sort());
    for (const { slug } of KNOWN_TOOLS) assert.match(draw(slug), new RegExp(`au-m-${slug}`));
  });

  it("draws a neutral mascot for a tool it has none for", () => {
    assert.match(draw("some-new-cli"), /au-m-generic/);
  });

  it("is decorative: hidden from screen readers, because the tool's name is always printed beside it", () => {
    for (const slug of [...MASCOT_SLUGS, "other"]) assert.match(draw(slug), /<svg[^>]*aria-hidden="true"/);
  });

  it("keeps its gradient and clip ids apart, so two mascots on one page never take each other's", () => {
    const ids = MASCOT_SLUGS.flatMap((slug) => [...draw(slug).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("stops every animation under prefers-reduced-motion", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf("Overview, tool pages and mascots")));
    assert.match(block, /\.au-mascot \*/);
    assert.match(block, /animation: none !important/);
  });
});
