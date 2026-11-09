import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@modunexo/sdk";
import { readMigrationFiles } from "@modunexo/core";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import { parsePrices } from "../../modules/ai-usage/web/metrics.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

describe("ai-usage manifest", () => {
  it("is valid and owns its own schema", () => {
    assert.doesNotThrow(() => validateManifest(aiUsage));
    assert.equal(aiUsage.id, "ai-usage");
    assert.equal(aiUsage.schema, "ai_usage");
    assert.deepEqual(aiUsage.nav?.map((n) => n.href), ["/ai-usage"]);
    assert.deepEqual(aiUsage.pages?.map((p) => p.path), ["/ai-usage", "/ai-usage/[tool]", "/svc/ai-usage/ingest"]);
    assert.equal(aiUsage.pages?.[0]?.entry, "./web/page.tsx");
    assert.equal(aiUsage.pages?.[1]?.entry, "./web/tool-page.tsx");
    assert.equal(aiUsage.pages?.[1]?.permission, "ai_usage.read", "a tool page needs the same permission as the overview");
  });

  it("explains how to connect a machine in its settings, which only an administrator can open", () => {
    const setting = aiUsage.settings?.find((entry) => entry.key === "platform_url");
    assert.ok(setting);
    assert.equal(setting.type, "string");
    assert.match(setting.description ?? "", /API access/);
    assert.match(setting.description ?? "", /ai_usage\.write/);
    assert.match(setting.description ?? "", /--dry-run/);
  });

  it("lets an administrator enter model prices, in a format the price parser reads", () => {
    const setting = aiUsage.settings?.find((entry) => entry.key === "model_prices");
    assert.ok(setting);
    assert.equal(setting.type, "string");
    assert.match(setting.description ?? "", /input\/cache read\/cache write\/output/);
    assert.match(setting.description ?? "", /million tokens/);
    assert.equal(parsePrices(setting.default).ignored, 0, "the example in the description must parse");
  });

  it("ships ordered migrations", () => {
    const files = readMigrationFiles(MODULE_DIR + "migrations");
    assert.ok(files.length >= 1);
    assert.equal(files[0]!.filename, "0001_init.sql");
  });
});
