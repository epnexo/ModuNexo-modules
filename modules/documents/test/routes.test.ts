import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "modules/documents/package.json"), "utf8")) as { exports: Record<string, string> };

/** Every page of the module: the URL's route file in the app, and the module export it must re-export. */
const ROUTES = [
  { route: "documents/page.tsx", export: "./web/page" },
  { route: "documents/templates/page.tsx", export: "./web/page-templates" },
  { route: "documents/templates/new/page.tsx", export: "./web/page-template-new" },
  { route: "documents/templates/[id]/page.tsx", export: "./web/page-template-edit" },
  { route: "documents/settings/page.tsx", export: "./web/page-settings" },
  { route: "documents/new/page.tsx", export: "./web/page-new-document" },
  { route: "documents/[id]/page.tsx", export: "./web/page-document" },
];

/** Route handlers re-export the verbs they serve from the module. */
const HANDLERS = [
  { route: "documents/[id]/pdf/route.ts", export: "./web/pdf-route", verbs: ["GET"] },
  { route: "documents/[id]/signed-pdf/route.ts", export: "./web/signed-pdf-route", verbs: ["GET"] },
  { route: "documents/templates/[id]/preview/route.ts", export: "./web/template-preview-route", verbs: ["GET"] },
];

describe("documents routes", () => {
  for (const { route, export: exportName } of ROUTES) {
    it(`mounts ${exportName} at ${route}`, () => {
      const file = join(root, "apps/web/src/app", route);
      assert.ok(existsSync(file), `${route} is missing`);
      const source = readFileSync(file, "utf8");
      assert.match(source, new RegExp(`export \\{ default, metadata \\} from "@epnexo/documents/${exportName.slice(2)}"`));
      assert.match(source, /export const dynamic = "force-dynamic";/);
      assert.ok(pkg.exports[exportName], `${exportName} is not exported by the package`);
      assert.ok(existsSync(join(root, "modules/documents", pkg.exports[exportName]!)), `${pkg.exports[exportName]} is missing`);
    });
  }

  for (const { route, export: exportName, verbs } of HANDLERS) {
    it(`mounts the ${verbs.join(", ")} handler of ${exportName} at ${route}`, () => {
      const source = readFileSync(join(root, "apps/web/src/app", route), "utf8");
      assert.match(source, new RegExp(`export \\{ ${verbs.join(", ")} \\} from "@epnexo/documents/${exportName.slice(2)}"`));
      assert.match(source, /export const dynamic = "force-dynamic";/);
      assert.ok(existsSync(join(root, "modules/documents", pkg.exports[exportName]!)), `${exportName} is missing`);
    });
  }

  it("does not export a server-only file to the app other than through a page or a handler", () => {
    assert.deepEqual(Object.keys(pkg.exports).filter((key) => !["./manifest", ...ROUTES.map((r) => r.export), ...HANDLERS.map((h) => h.export)].includes(key)), []);
  });
});
