import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Registry, coreManifest, discoverModules, readMigrationFiles } from "@epnexo/core";

const modulesDir = fileURLToPath(new URL("../..", import.meta.url));

describe("documents manifest", () => {
  it("is discovered, valid and installs after the core", async () => {
    const registry = new Registry();
    registry.register(coreManifest);
    for (const manifest of await discoverModules(modulesDir)) registry.register(manifest);

    const documents = registry.get("documents");
    assert.ok(documents);
    assert.equal(documents.schema, "documents");
    assert.deepEqual(documents.nav, [{ label: "Documents", href: "/documents" }]);
    const order = registry.resolveOrder().map((m) => m.id);
    assert.ok(order.indexOf("documents") > order.indexOf("core"));
  });

  it("ships ordered migrations", async () => {
    const manifest = (await discoverModules(modulesDir)).find((m) => m.id === "documents")!;
    const files = readMigrationFiles(manifest.migrationsDir);
    assert.ok(files.length >= 1);
    assert.equal(files[0]!.filename, "0001_init.sql");
  });
});
