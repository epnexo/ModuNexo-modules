import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { docusealFromEnv } from "../src/docuseal-client.ts";
import { renderSettingsFromEnv } from "../src/pdf-engine.ts";

test("loadConfig maps the module settings to what the builders read, and leaves unset ones out", async () => {
  const stored: Record<string, string | number> = { "docuseal.url": "http://127.0.0.1:3001", "docuseal.token": "tok", "engine.url": "http://engine:8080", "engine.token": "etok", "engine.python": "/usr/bin/python3", "engine.timeout_ms": 90000 };
  const asked: string[] = [];
  const env = await loadConfig(async (moduleId, key) => {
    assert.equal(moduleId, "documents");
    asked.push(key);
    return stored[key] ?? null;
  });
  assert.deepEqual(env, { DOCUSEAL_URL: "http://127.0.0.1:3001", DOCUSEAL_API_TOKEN: "tok", DOCUMENTS_ENGINE_URL: "http://engine:8080", DOCUMENTS_ENGINE_TOKEN: "etok", DOCUMENTS_PYTHON: "/usr/bin/python3", DOCUMENTS_RENDER_TIMEOUT_MS: "90000" });
  assert.equal(asked.length, 7);
  assert.equal(docusealFromEnv(env).ok, true);
  assert.deepEqual(renderSettingsFromEnv(env), { python: "/usr/bin/python3", assetsDir: undefined, timeoutMs: 90000 });
});

test("with nothing set, signing and the engine are not configured", async () => {
  const env = await loadConfig(async () => null);
  assert.deepEqual(env, {});
  assert.deepEqual(docusealFromEnv(env), { ok: false, error: { kind: "not-configured" } });
});
