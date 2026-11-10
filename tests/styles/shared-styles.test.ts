import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
});
