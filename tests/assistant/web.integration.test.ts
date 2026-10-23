import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { validateManifest } from "@modunexo/sdk";
import { POST as pauseRoute } from "../../assistant/web/pause.ts";
import { POST as resumeRoute } from "../../assistant/web/resume.ts";
import { POST as saveRoute } from "../../assistant/web/settings-save.ts";
import AssistantPage from "../../assistant/web/assistant-page.tsx";
import SettingsPage from "../../assistant/web/settings-page.tsx";
import { loadConfig, saveConfig, type Config } from "../../assistant/lib/config.ts";
import { pauseConversation, pausedReason } from "../../assistant/lib/state.ts";
import assistant from "../../assistant/manifest.ts";
import inbox from "../../inbox/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { SettingsService } from "@modunexo/core/settings-service";
import { createScratchDatabase } from "@modunexo/core/testing";

const INBOX_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));
const MODULE_DIR = fileURLToPath(new URL("../../assistant/", import.meta.url));
const KEY = "k".repeat(40);
const CONFIG: Config = { enabled: false, instructions: "", waitSeconds: 5, historyMessages: 20, maxRepliesPerHour: 10 };

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let settings: SettingsService;

before(async () => {
  process.env.MODUNEXO_MASTER_KEY = KEY;
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
  settings = new SettingsService(pool, registry, { masterKey: KEY });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  for (const table of ["inbox.messages", "inbox.conversations", "assistant.replies", "assistant.paused", "assistant.resumed"]) await pool!.query(`delete from ${table}`);
  await saveConfig(CONFIG);
  await settings.set("assistant", "llm.url", "https://models.example/v1", "test");
  await settings.set("assistant", "inbox_url", "http://127.0.0.1:3000", "test");
  await settings.set("assistant", "inbox_token", "mdnx_abcd1234_token-0123456789abcdefghijklmnopqrstuvwxyz", "test");
});

const html = async (page: Promise<unknown>) => renderToStaticMarkup((await page) as never);
const assistantHtml = () => html(AssistantPage());
async function conversation(name: string | null, ref: string, last = "2026-10-23T10:00:00Z"): Promise<number> {
  const made = await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_ref, contact_name, last_message_at) values ('web', $1, $2, $3, $4) returning id", [`t-${ref}`, ref, name, last]);
  return Number(made.rows[0].id);
}
async function message(conversationId: number, direction: "in" | "out", text: string): Promise<number> {
  return Number((await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', $2, $3, 'sent') returning id", [conversationId, direction, text])).rows[0].id);
}

describe("the assistant manifest declares the pages and the routes", () => {
  it("opens the two pages for readers and the three form routes for writers, none of them public", () => {
    const checked = validateManifest(assistant);
    const byPath = new Map(checked.pages?.map((page) => [page.path, page]));
    for (const path of ["/assistant", "/assistant/settings"]) {
      assert.equal(byPath.get(path)?.kind, "page", path);
      assert.equal(byPath.get(path)?.permission, "assistant.read", path);
    }
    for (const path of ["/assistant/settings/save", "/assistant/pause", "/assistant/resume"]) {
      assert.equal(byPath.get(path)?.kind, "route", path);
      assert.deepEqual(byPath.get(path)?.methods, ["POST"], path);
      assert.equal(byPath.get(path)?.permission, "assistant.write", path);
    }
    assert.equal(checked.pages?.some((page) => page.public !== undefined || page.scope !== undefined), false);
    assert.deepEqual(checked.nav?.map((e) => [e.label, e.href, e.permission]), [["Assistant", "/assistant", "assistant.read"]]);
  });
});

describe("/assistant", { concurrency: false }, () => {
  it("says it is switched off, and that nothing is answered, by default", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await assistantHtml();
    assert.match(out, /Switched off/);
    assert.match(out, /href="\/assistant\/settings"/);
  });

  it("says it is switched on, and where the customers' messages go, once it is on", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, enabled: true });
    const out = await assistantHtml();
    assert.match(out, /Switched on/);
    assert.match(out, /models\.example/);
    assert.doesNotMatch(out, /https:\/\/models\.example\/v1/, "only the host, never the whole address");
  });

  it("warns about each connection setting that is missing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, enabled: true });
    assert.doesNotMatch(await assistantHtml(), /is not set/);
    await settings.unset("assistant", "inbox_token", "test");
    assert.match(await assistantHtml(), /inbox token is not set/i);
    await settings.unset("assistant", "llm.url", "test");
    assert.match(await assistantHtml(), /model endpoint is not set/i);
  });

  it("lists the recent conversations with who they are and whether the assistant is active, with a Pause form", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await conversation("Ada", "c-1", "2026-10-23T10:00:00Z");
    await message(ada, "in", "hello");
    const out = await assistantHtml();
    assert.match(out, /Ada/);
    assert.match(out, /Active/);
    assert.match(out, /action="\/assistant\/pause"/);
    assert.match(out, new RegExp(`<input type="hidden" name="conversationId" value="${ada}"`));
  });

  it("shows a stopped conversation with the reason and a Resume form, and no Pause form for it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const grace = await conversation(null, "+57300");
    await pauseConversation(grace, "human");
    const out = await assistantHtml();
    assert.match(out, /\+57300/, "a person without a name is shown by their reference");
    assert.match(out, /Stopped/);
    assert.match(out, /a person wrote/i);
    assert.match(out, /action="\/assistant\/resume"/);
    assert.doesNotMatch(out, /action="\/assistant\/pause"/);
  });

  it("explains each reason in words", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const reasons: [string, RegExp][] = [["human", /a person wrote/i], ["handoff", /asked for a person/i], ["limit", /hourly limit/i], ["manual", /stopped by hand/i]];
    for (const [reason, words] of reasons) {
      await pool!.query("delete from assistant.paused");
      await pauseConversation(await conversation(`P-${reason}`, `r-${reason}`), reason as never);
      assert.match(await assistantHtml(), words, reason);
    }
  });

  it("shows the latest replies with their text, and the error of one that failed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await conversation("Ada", "c-1");
    const asked = await message(ada, "in", "do you open on Sunday?");
    const sent = await message(ada, "out", "We open at 9 on weekdays.");
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, message_id, status, model) values ($1, $2, $3, 'sent', 'test-model')", [ada, asked, sent]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, error) values ($1, $2, 'failed', 'model: timeout')", [ada, asked + 1]);
    const out = await assistantHtml();
    assert.match(out, /We open at 9 on weekdays\./);
    assert.match(out, /test-model/);
    assert.match(out, /model: timeout/);
  });

  it("escapes what customers and the model wrote", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const evil = await conversation('<script>alert("x")</script>', "c-evil");
    const out = await message(evil, "out", "<img src=x onerror=alert(1)>");
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, message_id, status) values ($1, 1, $2, 'sent')", [evil, out]);
    const markup = await assistantHtml();
    assert.doesNotMatch(markup, /<script>alert/);
    assert.doesNotMatch(markup, /<img src=x/);
    assert.match(markup, /&lt;script&gt;/);
  });
});

describe("/assistant/settings", { concurrency: false }, () => {
  it("shows the current values, escapes the instructions, and explains where the connection settings are", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ enabled: true, instructions: "We sell <b>shoes</b>.", waitSeconds: 9, historyMessages: 7, maxRepliesPerHour: 3 });
    const out = await html(SettingsPage());
    assert.match(out, /action="\/assistant\/settings\/save"/);
    assert.match(out, /name="enabled"[^>]*checked|checked[^>]*name="enabled"/);
    assert.match(out, /We sell &lt;b&gt;shoes&lt;\/b&gt;\./);
    assert.doesNotMatch(out, /<b>shoes<\/b>/);
    for (const [name, value] of [["waitSeconds", "9"], ["historyMessages", "7"], ["maxRepliesPerHour", "3"]]) assert.match(out, new RegExp(`name="${name}"[^>]*value="${value}"|value="${value}"[^>]*name="${name}"`), name);
    assert.match(out, /Settings/);
    assert.match(out, /model provider/i);
  });

  it("is unchecked while it is off", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.doesNotMatch(await html(SettingsPage()), /name="enabled"[^>]*checked|checked[^>]*name="enabled"/);
  });
});

describe("the form routes", { concurrency: false }, () => {
  const SAME = { origin: "http://shell.test", host: "shell.test" };
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = SAME) =>
    new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const location = (response: Response) => response.headers.get("location");
  const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

  it("refuse another site, a request with no origin and a body that is not a form, and change nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("Ada", "c-1");
    const routes: [string, (request: Request) => Promise<Response>, Record<string, string>][] = [
      ["/assistant/settings/save", saveRoute, { enabled: "on", instructions: "x", waitSeconds: "5", historyMessages: "20", maxRepliesPerHour: "10" }],
      ["/assistant/pause", pauseRoute, { conversationId: String(id) }],
      ["/assistant/resume", resumeRoute, { conversationId: String(id) }],
    ];
    for (const [path, handler, fields] of routes) {
      assert.equal((await handler(form(path, fields, { origin: "http://evil.test", host: "shell.test" }))).status, 403, path);
      assert.equal((await handler(form(path, fields, { host: "shell.test" }))).status, 403, path);
      const notAForm = new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...SAME }, body: JSON.stringify(fields) });
      assert.equal((await handler(notAForm)).status, 400, path);
    }
    assert.deepEqual(await loadConfig(), CONFIG);
    assert.equal(await pausedReason(id), null);
  });

  it("settings/save stores the settings and goes back to the settings page", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await saveRoute(form("/assistant/settings/save", { enabled: "on", instructions: "  Be kind.  ", waitSeconds: "8", historyMessages: "12", maxRepliesPerHour: "30" }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/assistant/settings");
    assert.deepEqual(await loadConfig(), { enabled: true, instructions: "Be kind.", waitSeconds: 8, historyMessages: 12, maxRepliesPerHour: 30 });
  });

  it("settings/save switches it off when the box is not sent, and answers 400 naming the field without changing anything", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, enabled: true, instructions: "keep me" });
    const bad = await saveRoute(form("/assistant/settings/save", { instructions: "x", waitSeconds: "999", historyMessages: "20", maxRepliesPerHour: "10" }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"waitSeconds"/);
    assert.equal((await loadConfig()).enabled, true);
    await saveRoute(form("/assistant/settings/save", { instructions: "keep me", waitSeconds: "5", historyMessages: "20", maxRepliesPerHour: "10" }));
    assert.equal((await loadConfig()).enabled, false);
  });

  it("pause stops the assistant in that conversation, by hand", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("Ada", "c-1");
    const response = await pauseRoute(form("/assistant/pause", { conversationId: String(id) }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/assistant");
    assert.equal(await pausedReason(id), "manual");
  });

  it("resume lets it answer again, also when it was not stopped", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("Ada", "c-1");
    await pauseConversation(id, "limit");
    assert.equal((await resumeRoute(form("/assistant/resume", { conversationId: String(id) }))).status, 303);
    assert.equal(await pausedReason(id), null);
    assert.equal((await resumeRoute(form("/assistant/resume", { conversationId: String(id) }))).status, 303, "pressing it twice is harmless");
  });

  it("resume remembers the newest message of the conversation as the point to start again from, only if it was stopped", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("Ada", "c-1");
    const last = await message(id, "in", "hello");
    await resumeRoute(form("/assistant/resume", { conversationId: String(id) }));
    assert.deepEqual((await pool!.query("select * from assistant.resumed")).rows, [], "nothing was stopped, nothing to remember");
    await pauseConversation(id, "human");
    await resumeRoute(form("/assistant/resume", { conversationId: String(id) }));
    const row = (await pool!.query("select conversation_id, after_message_id from assistant.resumed")).rows[0];
    assert.deepEqual([Number(row.conversation_id), Number(row.after_message_id)], [id, last]);
  });

  it("pause and resume answer 400 for an id that is not a number and 404 for a conversation the inbox does not have", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const [path, handler] of [["/assistant/pause", pauseRoute], ["/assistant/resume", resumeRoute]] as const) {
      assert.equal((await handler(form(path, { conversationId: "x" }))).status, 400, path);
      assert.equal((await handler(form(path, {}))).status, 400, path);
      assert.equal((await handler(form(path, { conversationId: "424242" }))).status, 404, path);
    }
    assert.deepEqual((await pool!.query("select * from assistant.paused")).rows, []);
  });
});
