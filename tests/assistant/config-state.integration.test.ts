import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import assistant from "../../assistant/manifest.ts";
import { configInput, loadConfig, saveConfig } from "../../assistant/lib/config.ts";
import { listPaused, pauseConversation, pausedReason, resumeConversation } from "../../assistant/lib/state.ts";
import inbox from "../../inbox/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const INBOX_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));
const MODULE_DIR = fileURLToPath(new URL("../../assistant/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(inbox);
  registry.register(assistant);
  await migrate(pool, registry, { moduleDirs: { inbox: INBOX_DIR, assistant: MODULE_DIR } });
  for (const module of [inbox, assistant]) await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', $2)", [module.id, module.version]);
  registerModuleRuntime(pool, { current: registry });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("delete from assistant.paused");
  await saveConfig({ enabled: false, instructions: "", waitSeconds: 5, historyMessages: 20, maxRepliesPerHour: 10 });
});

describe("the assistant manifest", () => {
  it("is valid, depends on the inbox, subscribes its job to the inbox event and declares the model and the connection settings", () => {
    const checked = validateManifest(assistant);
    assert.deepEqual(checked.dependsOn, { inbox: "^0.3.0" });
    assert.deepEqual(checked.subscriptions, [{ event: "inbox.message.received", job: "answer" }]);
    assert.equal(checked.jobs?.find((j) => j.name === "answer")?.maxAttempts, 3);
    const keys = checked.settings?.map((s) => [s.key, s.type, s.required === true]);
    assert.deepEqual(keys, [["llm.url", "string", true], ["llm.key", "secret", false], ["llm.model", "string", false], ["inbox_url", "string", true], ["inbox_token", "secret", true]]);
    assert.deepEqual(checked.llm, { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" });
  });
});

describe("the module's own configuration", { concurrency: false }, () => {
  it("starts switched off, with no instructions, a 5-second wait, 20 messages of history and 10 replies an hour", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pool!.query("update assistant.config set enabled = default, instructions = default, wait_seconds = default, history_messages = default, max_replies_per_hour = default");
    assert.deepEqual(await loadConfig(), { enabled: false, instructions: "", waitSeconds: 5, historyMessages: 20, maxRepliesPerHour: 10 });
  });

  it("reads the form: a checked box is on, an absent one is off, and the text is trimmed", () => {
    const on = configInput({ enabled: "on", instructions: "  Be kind.  ", waitSeconds: "8", historyMessages: "12", maxRepliesPerHour: "30" });
    assert.deepEqual(on, { ok: true, value: { enabled: true, instructions: "Be kind.", waitSeconds: 8, historyMessages: 12, maxRepliesPerHour: 30 } });
    const off = configInput({ instructions: "", waitSeconds: "0", historyMessages: "1", maxRepliesPerHour: "1" });
    assert.deepEqual(off, { ok: true, value: { enabled: false, instructions: "", waitSeconds: 0, historyMessages: 1, maxRepliesPerHour: 1 } });
  });

  it("refuses what it cannot use and names the field", () => {
    const base = { enabled: "on", instructions: "x", waitSeconds: "5", historyMessages: "20", maxRepliesPerHour: "10" };
    const bad: [string, Record<string, string>][] = [
      ["instructions", { instructions: "x".repeat(8001) }],
      ["instructions", { instructions: "a\u0000b" }],
      ["waitSeconds", { waitSeconds: "61" }],
      ["waitSeconds", { waitSeconds: "-1" }],
      ["waitSeconds", { waitSeconds: "five" }],
      ["historyMessages", { historyMessages: "0" }],
      ["historyMessages", { historyMessages: "51" }],
      ["maxRepliesPerHour", { maxRepliesPerHour: "0" }],
      ["maxRepliesPerHour", { maxRepliesPerHour: "101" }],
      ["enabled", { enabled: "maybe" }],
    ];
    for (const [field, over] of bad) {
      const out = configInput({ ...base, ...over });
      assert.equal(out.ok, false, JSON.stringify(over));
      if (!out.ok) assert.match(out.error, new RegExp(`"${field}"`), JSON.stringify(over));
    }
    assert.equal(configInput({ ...base, instructions: "x".repeat(8000) }).ok, true);
  });

  it("saves and loads what it was given", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const wanted = { enabled: true, instructions: "We sell shoes.", waitSeconds: 9, historyMessages: 7, maxRepliesPerHour: 3 };
    await saveConfig(wanted);
    assert.deepEqual(await loadConfig(), wanted);
  });
});

describe("the conversations the assistant has stopped", { concurrency: false }, () => {
  it("remembers the reason, keeps the first reason when stopped again, and forgets on resume", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal(await pausedReason(7), null);
    await pauseConversation(7, "human");
    assert.equal(await pausedReason(7), "human");
    await pauseConversation(7, "limit");
    assert.equal(await pausedReason(7), "human", "the first reason stays");
    assert.equal(await resumeConversation(7), true);
    assert.equal(await pausedReason(7), null);
    assert.equal(await resumeConversation(7), false, "nothing to resume");
  });

  it("lists the stopped conversations with their reason, the newest first", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pauseConversation(1, "manual");
    await pool!.query("update assistant.paused set since = now() - interval '1 hour' where conversation_id = 1");
    await pauseConversation(2, "handoff");
    assert.deepEqual((await listPaused()).map((p) => [p.conversationId, p.reason]), [[2, "handoff"], [1, "manual"]]);
  });

  it("refuses a reason it does not know", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await assert.rejects(pauseConversation(3, "because" as never));
  });
});
