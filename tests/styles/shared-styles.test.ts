import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const MODULES = new URL("../../modules/", import.meta.url).pathname;
const GUIDE = readFileSync(new URL("../../docs/GUIDE.md", import.meta.url), "utf8");

/** The .tsx files of every module's web folder, except the one module that owns a design layer of its own. */
function pages(): string[] {
  const files: string[] = [];
  for (const id of readdirSync(MODULES)) {
    if (id === "ai-usage") continue;
    const web = join(MODULES, id, "web");
    if (!statSync(MODULES + id).isDirectory() || !readdirSync(join(MODULES, id)).includes("web")) continue;
    for (const name of readdirSync(web)) if (name.endsWith(".tsx")) files.push(join(web, name));
  }
  return files;
}

describe("shared styles", () => {
  it("has no module write the surface-card recipe by hand: it uses the platform's `card` class", () => {
    const recipe = /rounded-(md|lg)\s+border\s+border-border\s+bg-surface\s+p-\d/;
    const offenders = pages().filter((file) => recipe.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, [], "use className=\"card\" (and p-3 for a dense one) instead of the hand-written box");
  });

  it("has no module hard-code a color value or a dark: color in a page", () => {
    const offenders = pages().filter((file) => /(#[0-9a-fA-F]{3,8}\b|\bdark:(bg|text|border)-|\boklch\()/.test(readFileSync(file, "utf8").replace(/\/\/.*$/gm, "")));
    assert.deepEqual(offenders, [], "colors come from the tokens (bg-surface, text-muted, ...), which follow the theme");
  });

  it("documents the global classes a module can use", () => {
    for (const name of ["card", "badge", "badge-warning", "icon-tile", "--card-pad", "--card-line-opacity"]) assert.ok(GUIDE.includes(name), `the guide explains ${name}`);
  });

  it("documents every component a module can use", () => {
    for (const name of ["seg", "stats", "stat-value", "notice-error", "notice-success", "data-table", "table-scroll", "--stat-tone", "--stat-line", "btn-primary", "field-error", "form-grid", "form-actions", "detail-list"]) assert.ok(GUIDE.includes(name), `the guide explains ${name}`);
  });
});

/** The platform's own classes. A module uses them in its markup and never names them in its own stylesheet. */
const PLATFORM_CLASS = /\.(card|badge(-[\w]+)?|icon-tile|seg|stats?|stat-(label|value|sub)|notice(-[\w]+)?|table-scroll|data-table|btn(-[\w]+)?|input|field(-[\w]+)?|form(-[\w]+)?|detail-list)(?![\w-])/;

/** The stylesheets modules own: `modules/<id>/web/*.css`. */
function stylesheets(): { id: string; file: string; css: string }[] {
  const found: { id: string; file: string; css: string }[] = [];
  for (const id of readdirSync(MODULES)) {
    const web = join(MODULES, id, "web");
    if (!existsSync(web)) continue;
    for (const name of readdirSync(web)) if (name.endsWith(".css")) found.push({ id, file: `${id}/web/${name}`, css: readFileSync(join(web, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") });
  }
  return found;
}

/** Every selector the stylesheet declares, leaving out keyframe steps and at-rule headers. */
function selectorsOf(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1]!.trim();
    if (prelude.startsWith("@") || /^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(prelude)) continue;
    for (const selector of prelude.split(",")) out.push(selector.trim());
  }
  return out;
}

describe("a module's own stylesheet stays inside the module", () => {
  const sheets = stylesheets();

  it("finds the stylesheets there are, so this check is never empty", () => {
    assert.ok(sheets.length > 0);
  });

  for (const { file, css } of sheets) {
    const selectors = selectorsOf(css);
    // The module's root class is the one its first rule names, for example `.au`; every other class starts with it and a dash.
    const root = selectors[0]?.match(/^\.([a-z][a-z0-9]*)(?:-|(?![\w-]))/)?.[1];

    it(`${file}: every selector sits under the module's root class or prefix`, () => {
      assert.ok(root, "the first rule names the module's root class, for example `.au`");
      const outside = selectors.filter((selector) => !new RegExp(`^(:root\\s+)?\\.${root}(?![a-z0-9])`).test(selector));
      assert.deepEqual(outside, [], `start these with .${root} or .${root}-`);
    });

    it(`${file}: no selector names a platform class; the module sets the documented variables instead`, () => {
      assert.deepEqual(selectors.filter((selector) => PLATFORM_CLASS.test(selector)), [], "use the class in the markup and change it through its variables");
    });

    it(`${file}: a colour value appears only as a custom property or a var() fallback`, () => {
      const rest = css.replace(/--[\w-]+\s*:[^;}]*/g, "").replace(/var\(\s*--[\w-]+\s*,[^()]*(\([^()]*\))?[^()]*\)/g, "");
      assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b|oklch\([^)]*\)|rgba?\([^)]*\)/g) ?? [], [], "colours come from tokens or from a named variable");
    });
  }
});
