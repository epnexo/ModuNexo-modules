import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "modules");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every stylesheet a module ships next to its pages: `modules/<id>/web/*.css`. */
const sheets = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const web = join(root, entry.name, "web");
    try {
      return readdirSync(web).filter((file) => file.endsWith(".css")).map((file) => ({ id: entry.name, file, path: join(web, file) }));
    } catch {
      return [];
    }
  });

describe("a module's stylesheet sits in the module layer", () => {
  it("finds the stylesheets of the modules that ship one", () => {
    assert.ok(sheets.length >= 3, `found ${sheets.map((s) => `${s.id}/${s.file}`).join(", ")}`);
  });

  for (const sheet of sheets) {
    it(`${sheet.id}/${sheet.file} is one \`@layer module { ... }\` block and nothing outside it`, () => {
      const css = stripComments(readFileSync(sheet.path, "utf8")).trim();
      assert.match(css, /^@layer module\s*\{/, "starts with the layer");
      let depth = 0;
      let closedAt = -1;
      for (let i = 0; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") {
          depth--;
          if (depth === 0) {
            closedAt = i;
            break;
          }
        }
      }
      assert.ok(closedAt > 0, "the layer is closed");
      assert.equal(css.slice(closedAt + 1).trim(), "", "nothing follows the layer: the platform's order puts it after the components and utilities, so it keeps winning over them as before, but loses to what a company or a person customizes");
    });
  }
});
