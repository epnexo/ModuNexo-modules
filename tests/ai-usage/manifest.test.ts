import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@modunexo/sdk";
import { readMigrationFiles } from "@modunexo/core";
import aiUsage from "../../modules/ai-usage/manifest.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

describe("ai-usage manifest", () => {
  it("is valid and owns its own schema", () => {
    assert.doesNotThrow(() => validateManifest(aiUsage));
    assert.equal(aiUsage.id, "ai-usage");
    assert.equal(aiUsage.schema, "ai_usage");
    assert.deepEqual(aiUsage.nav, [{ label: "AI usage", href: "/ai-usage", icon: "chart", permission: "ai_usage.read" }]);
    assert.equal(aiUsage.pages?.[0]?.entry, "./web/page.tsx");
  });

  it("ships ordered migrations", () => {
    const files = readMigrationFiles(MODULE_DIR + "migrations");
    assert.ok(files.length >= 1);
    assert.equal(files[0]!.filename, "0001_init.sql");
  });
});
