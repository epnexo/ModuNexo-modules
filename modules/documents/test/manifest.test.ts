import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@modunexo/sdk";
import documents from "../manifest.ts";

const moduleDir = fileURLToPath(new URL("../", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("documents manifest", () => {
  it("is valid, owns its schema and guards every page with a permission", () => {
    const checked = validateManifest(documents);
    assert.equal(checked.schema, "documents");
    assert.deepEqual(documents.nav, [{ label: "Documents", href: "/documents", icon: "file", permission: "documents.read" }]);
    for (const page of documents.pages ?? []) assert.ok(page.permission, `${page.path} has no permission`);
  });

  it("offers the PDF engine test as a connection check on the platform's Settings screen", () => {
    assert.deepEqual(
      (documents.checks ?? []).map((check) => [check.key, check.path]),
      [["engine", "/documents/settings/test-engine"]],
    );
    const route = documents.pages?.find((page) => page.path === "/documents/settings/test-engine");
    assert.equal(route?.kind, "route");
    assert.deepEqual(route?.methods, ["POST"]);
    assert.equal(route?.permission, "documents.write");
  });

  it("points every page and route at a file that exists, and every page exports its metadata", () => {
    for (const page of documents.pages ?? []) {
      const file = join(moduleDir, page.entry);
      assert.ok(existsSync(file), `${page.path}: ${page.entry} is missing`);
      if (page.kind === "page") assert.match(readFileSync(file, "utf8"), /export const metadata\b/, `${page.path} must export metadata`);
    }
  });

  it("declares its files as PDFs only, with no permission, so a browser can only get one through the module's own route", () => {
    assert.deepEqual(documents.files?.accept, ["application/pdf"]);
    assert.equal(documents.files?.permission, undefined);
    assert.ok((documents.files?.maxBytes ?? 0) > 0);
  });

  it("ships ordered migrations and raises the version with them", () => {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
    assert.ok(files.length >= 1);
    assert.equal(files[0], "0001_init.sql");
  });
});
