import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Registry, coreManifest, discoverModules, readMigrationFiles } from "@epnexo/core";

const modulesDir = fileURLToPath(new URL("../..", import.meta.url));

describe("ai-usage manifest", () => {
  it("is discovered, valid and installs after the core", async () => {
    const registry = new Registry();
    registry.register(coreManifest);
    for (const manifest of await discoverModules(modulesDir)) registry.register(manifest);

    const aiUsage = registry.get("ai-usage");
    assert.ok(aiUsage);
    assert.equal(aiUsage.schema, "ai_usage");
    assert.deepEqual(aiUsage.nav, [{ label: "AI usage", href: "/ai-usage", icon: "chart" }]);
    assert.ok(registry.resolveOrder().map((m) => m.id).indexOf("ai-usage") > registry.resolveOrder().map((m) => m.id).indexOf("core"));
  });

  it("ships ordered migrations", async () => {
    const manifest = (await discoverModules(modulesDir)).find((m) => m.id === "ai-usage")!;
    const files = readMigrationFiles(manifest.migrationsDir);
    assert.ok(files.length >= 1);
    assert.equal(files[0]!.filename, "0001_init.sql");
  });
});
