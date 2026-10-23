import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import answerJob from "../../assistant/jobs/answer.ts";
import { answerMessage } from "../../assistant/lib/answer.ts";
import { saveConfig, type Config } from "../../assistant/lib/config.ts";
import { pausedReason, resumeConversation } from "../../assistant/lib/state.ts";
import assistant from "../../assistant/manifest.ts";
import inbox from "../../inbox/manifest.ts";
import { POST as inboxSend } from "../../inbox/web/svc-send.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { SettingsService } from "@modunexo/core/settings-service";
import { createScratchDatabase } from "@modunexo/core/testing";

const INBOX_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));
const MODULE_DIR = fileURLToPath(new URL("../../assistant/", import.meta.url));
const KEY = "k".repeat(40);
const LLM_KEY = "sk-the-model-api-key-0123456789";
const TOKEN = "mdnx_abcd1234_the-inbox-token-0123456789abcdefghijkl";
const NOW = new Date("2026-10-23T12:00:00Z");
const noSleep = async () => {};

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let settings: SettingsService;
let llmServer: Server;
let platformServer: Server;
let llmOrigin: string;
let platformOrigin: string;

let llmCalls: { auth: string | undefined; body: { model?: string; messages: { role: string; content: string }[] } }[] = [];
let llmAnswer = "We open at 9 on weekdays.";
let llmStatus = 200;
let platformMode: "ok" | "forbidden" | "boom" | "drop" | "not_found" = "ok";
let platformCalls = 0;
let llmHook: ((call: number) => Promise<void>) | null = null;
let platformHook: ((call: number) => Promise<void>) | null = null;

const CONFIG: Config = { enabled: true, instructions: "We sell shoes. Be friendly.", waitSeconds: 0, historyMessages: 20, maxRepliesPerHour: 10 };

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

  llmServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      llmCalls.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      if (llmHook) await llmHook(llmCalls.length);
      res.statusCode = llmStatus;
      res.setHeader("content-type", "application/json");
      if (llmStatus !== 200) return res.end(JSON.stringify({ error: { message: `provider says no, key ${LLM_KEY}` } }));
      res.end(JSON.stringify({ model: "test-model", choices: [{ message: { role: "assistant", content: llmAnswer }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
    });
  });
  platformServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      platformCalls += 1;
      if (platformHook) await platformHook(platformCalls);
      if (platformMode === "drop") return req.socket.destroy();
      if (platformMode === "not_found") {
        res.statusCode = 404;
        return res.end();
      }
      if (platformMode === "boom") {
        res.statusCode = 500;
        return res.end("internal details");
      }
      if (platformMode === "forbidden" || req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = platformMode === "forbidden" ? 403 : 401;
        return res.end();
      }
      const response = await inboxSend(new Request(`http://platform${req.url}`, { method: req.method, headers: { "content-type": "application/json" }, body: Buffer.concat(chunks).toString("utf8") }));
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(await response.text());
    });
  });
  await Promise.all([llmServer, platformServer].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  llmOrigin = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`;
  platformOrigin = `http://127.0.0.1:${(platformServer.address() as AddressInfo).port}`;
});

after(async () => {
  llmServer?.close();
  platformServer?.close();
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  llmCalls = [];
  llmAnswer = "We open at 9 on weekdays.";
  llmStatus = 200;
  platformMode = "ok";
  platformCalls = 0;
  llmHook = null;
  platformHook = null;
  for (const table of ["core.events", "core.jobs", "inbox.messages", "inbox.conversations", "assistant.replies", "assistant.paused"]) await pool!.query(`delete from ${table}`);
  await saveConfig(CONFIG);
  await settings.set("assistant", "llm.url", `${llmOrigin}/v1`, "test");
  await settings.set("assistant", "llm.key", LLM_KEY, "test");
  await settings.set("assistant", "llm.model", "test-model", "test");
  await settings.set("assistant", "inbox_url", platformOrigin, "test");
  await settings.set("assistant", "inbox_token", TOKEN, "test");
});

/** A conversation whose messages are `lines`: "in:text" is the customer's, "out:text" was sent by someone. Returns the ids. */
async function conversation(lines: string[], options: { at?: string } = {}): Promise<{ id: number; ids: number[] }> {
  const made = await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_ref, contact_name, unread_count) values ('web', $1, 'c-1', 'Ada', 1) returning id", [`t-${Math.random()}`]);
  const id = Number(made.rows[0].id);
  const ids: number[] = [];
  for (const line of lines) {
    const [direction, ...rest] = line.split(":");
    const stored = await pool!.query(
      "insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', $2, $3, $4, $5) returning id",
      [id, direction, rest.join(":"), direction === "in" ? "received" : "sent", options.at ?? NOW.toISOString()],
    );
    ids.push(Number(stored.rows[0].id));
  }
  return { id, ids };
}
/** Records the message at `index` as a reply the assistant sent earlier (long enough ago not to count for the hourly limit). */
const ours = (c: { id: number; ids: number[] }, index: number) =>
  pool!.query("insert into assistant.replies (conversation_id, in_reply_to, message_id, status, created_at) values ($1, $2, $3, 'sent', $4)", [c.id, c.ids[index - 1], c.ids[index], "2026-10-23T08:00:00Z"]);
const run = (c: { id: number; ids: number[] }, over: Partial<Parameters<typeof answerMessage>[0]> = {}) =>
  answerMessage({ conversationId: c.id, messageId: c.ids.at(-1)!, now: () => NOW, sleep: noSleep, ...over });
const outbound = async (id: number) => (await pool!.query("select id, text, status from inbox.messages where conversation_id = $1 and direction = 'out' order by id", [id])).rows as { id: string; text: string; status: string }[];
const replies = async () => (await pool!.query("select conversation_id, in_reply_to, message_id, status, model, prompt_tokens, completion_tokens, error from assistant.replies order by id")).rows;

describe("answerMessage: when it answers", { concurrency: false }, () => {
  it("does nothing while it is switched off", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, enabled: false });
    const c = await conversation(["in:Do you open on Sunday?"]);
    assert.equal(await run(c), "disabled");
    assert.equal(llmCalls.length + platformCalls, 0);
    assert.deepEqual(await outbound(c.id), []);
  });

  it("asks the model with the instructions and the conversation, sends the answer through the inbox and records it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:Hi", "out:Hello! How can I help?", "in:Do you open on Sunday?"]);
    await ours(c, 1); // the greeting was the assistant's own earlier reply
    assert.equal(await run(c), "answered");
    assert.equal(llmCalls.length, 1);
    const asked = llmCalls[0]!;
    assert.equal(asked.auth, `Bearer ${LLM_KEY}`);
    assert.equal(asked.body.model, "test-model");
    assert.equal(asked.body.messages[0]!.role, "system");
    assert.match(asked.body.messages[0]!.content, /We sell shoes\. Be friendly\./);
    assert.deepEqual(asked.body.messages.slice(1), [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello! How can I help?" }, { role: "user", content: "Do you open on Sunday?" }]);
    const sent = await outbound(c.id);
    assert.deepEqual(sent.slice(-1).map((m) => [m.text, m.status]), [["We open at 9 on weekdays.", "queued"]]);
    const row = (await replies()).at(-1)!;
    assert.deepEqual([row.status, Number(row.message_id), Number(row.in_reply_to), row.model, row.prompt_tokens, row.completion_tokens], ["sent", Number(sent.at(-1)!.id), c.ids[2], "test-model", 11, 7]);
  });

  it("gives the model only the last historyMessages messages", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, historyMessages: 3 });
    const c = await conversation(["in:one", "out:two", "in:three", "out:four", "in:five", "in:six"]);
    await ours(c, 1);
    await ours(c, 3);
    assert.equal(await run(c), "answered");
    assert.deepEqual(llmCalls[0]!.body.messages.slice(1).map((m) => m.content), ["four", "five", "six"]);
  });

  it("does nothing for a message when a newer customer message exists, because the newer one will be answered", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:first", "in:second"]);
    assert.equal(await run(c, { messageId: c.ids[0]! }), "superseded");
    assert.equal(llmCalls.length, 0);
  });

  it("notices a message that arrives while it waits", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, waitSeconds: 6 });
    const c = await conversation(["in:first"]);
    let waited = 0;
    const sleep = async (ms: number) => {
      waited = ms;
      await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', 'in', 'second', 'received', $2)", [c.id, NOW.toISOString()]);
    };
    assert.equal(await run(c, { sleep }), "superseded");
    assert.equal(waited, 6000);
    assert.equal(llmCalls.length, 0);
  });

  it("stops if it is switched off or the conversation is stopped while it waits", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, waitSeconds: 3 });
    const a = await conversation(["in:hello"]);
    assert.equal(await run(a, { sleep: async () => saveConfig({ ...CONFIG, waitSeconds: 3, enabled: false }) }), "disabled");
    await saveConfig({ ...CONFIG, waitSeconds: 3 });
    const b = await conversation(["in:hello"]);
    const sleep = async () => { await pool!.query("insert into assistant.paused (conversation_id, reason) values ($1, 'manual')", [b.id]); };
    assert.equal(await run(b, { sleep }), "paused");
    assert.equal(llmCalls.length, 0);
  });

  it("does not answer a customer message older than 15 minutes", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:anyone there?"], { at: "2026-10-23T11:40:00Z" });
    assert.equal(await run(c), "stale");
    assert.equal(llmCalls.length, 0);
    const fresh = await conversation(["in:anyone there?"], { at: "2026-10-23T11:50:00Z" });
    assert.equal(await run(fresh), "answered");
  });
});

describe("answerMessage: one reply per customer message", { concurrency: false }, () => {
  it("answers a message once, however many times the job runs", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:Do you open on Sunday?"]);
    assert.equal(await run(c), "answered");
    assert.equal(await run(c), "answered_already");
    assert.equal(llmCalls.length, 1);
    assert.equal((await outbound(c.id)).length, 1);
  });

  it("does not answer a message another job is already answering, and says it is busy when the reply in flight is for an earlier message", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const same = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, $2, 'sending', $3)", [same.id, same.ids[0], "2026-10-23T11:59:00Z"]);
    assert.equal(await run(same), "answered_already");
    const other = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, 999999, 'sending', $2)", [other.id, "2026-10-23T11:59:00Z"]);
    assert.equal(await run(other), "busy");
    assert.equal(llmCalls.length, 0);
  });

  it("takes over a claim that was abandoned more than five minutes ago", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, 1, 'sending', $2)", [c.id, "2026-10-23T11:50:00Z"]);
    assert.equal(await run(c), "answered");
    assert.equal((await replies())[0]!.error, "abandoned");
  });

  it("lets only one of several jobs for the same message through when they run together", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    const results = await Promise.all(Array.from({ length: 5 }, () => run(c)));
    assert.equal(results.filter((r) => r === "answered").length, 1);
    assert.equal(results.filter((r) => r === "answered_already").length, 4);
    assert.equal(llmCalls.length, 1);
    assert.equal((await outbound(c.id)).length, 1);
  });

  it("answers the next customer message after its own earlier reply without taking it for a person", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:first question"]);
    assert.equal(await run(c), "answered");
    const next = await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', 'in', 'second question', 'received', $2) returning id", [c.id, NOW.toISOString()]);
    assert.equal(await run({ id: c.id, ids: [Number(next.rows[0].id)] }), "answered");
    assert.equal(llmCalls.length, 2);
    assert.equal(await pausedReason(c.id), null);
  });
});

describe("answerMessage: when it stops by itself", { concurrency: false }, () => {
  it("steps back when a person has written in the conversation, and stays stopped", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello", "out:Hi, this is Marta from the shop", "in:can I come tomorrow?"]);
    assert.equal(await run(c), "human");
    assert.equal(await pausedReason(c.id), "human");
    assert.equal(llmCalls.length + platformCalls, 0);
    assert.equal(await run(c), "paused");
    assert.deepEqual((await replies()).map((r) => r.status), ["failed"], "the claim was released");
  });

  it("stops at the hourly limit and says why", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, maxRepliesPerHour: 2 });
    const c = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, 901, 'sent', $2), ($1, 902, 'sent', $3), ($1, 903, 'failed', $3)", [c.id, "2026-10-23T11:20:00Z", "2026-10-23T11:45:00Z"]);
    assert.equal(await run(c), "limit");
    assert.equal(await pausedReason(c.id), "limit");
    assert.equal(llmCalls.length, 0);
  });

  it("does not count replies older than an hour, nor those of other conversations", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, maxRepliesPerHour: 2 });
    const c = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, 901, 'sent', $2), ($1, 902, 'sent', $2), (999, 903, 'sent', $3)", [c.id, "2026-10-23T10:00:00Z", "2026-10-23T11:55:00Z"]);
    assert.equal(await run(c), "answered");
  });

  it("sends what is around the marker and stops when the model asks for a person", async (t) => {
    if (skipReason) return t.skip(skipReason);
    llmAnswer = "[[HANDOFF]] I will pass you to a person.";
    const c = await conversation(["in:I want to talk to someone"]);
    assert.equal(await run(c), "handoff");
    assert.deepEqual((await outbound(c.id)).map((m) => m.text), ["I will pass you to a person."]);
    assert.equal(await pausedReason(c.id), "handoff");
    assert.equal((await replies())[0]!.status, "sent");
    assert.equal(await run(c), "paused");
  });

  it("stops without sending anything when the model answers with the marker alone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    llmAnswer = "[[HANDOFF]]";
    const c = await conversation(["in:this is outrageous"]);
    assert.equal(await run(c), "handoff");
    assert.deepEqual(await outbound(c.id), []);
    assert.equal(await pausedReason(c.id), "handoff");
    assert.equal(platformCalls, 0);
  });

  it("sends nothing and does not stop when the model answers with nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    llmAnswer = "   ";
    const c = await conversation(["in:hello"]);
    assert.equal(await run(c), "nothing_to_say");
    assert.deepEqual(await outbound(c.id), []);
    assert.equal(await pausedReason(c.id), null);
  });
});

describe("answerMessage: when something fails", { concurrency: false }, () => {
  const refusal = (matcher: RegExp, secrets: string[]) => (error: Error) => {
    assert.match(error.message, matcher);
    for (const secret of secrets) assert.equal(error.message.includes(secret), false, `the error must not hold ${secret}`);
    return true;
  };

  it("fails so that the job is retried when the model errors, with a message that holds neither the key nor what the provider said, and lets a retry answer", async (t) => {
    if (skipReason) return t.skip(skipReason);
    llmStatus = 500;
    const c = await conversation(["in:hello"]);
    await assert.rejects(run(c), refusal(/model/i, [LLM_KEY, "provider says no", llmOrigin]));
    assert.deepEqual((await replies()).map((r) => r.status), ["failed"]);
    assert.deepEqual(await outbound(c.id), []);
    llmStatus = 200;
    assert.equal(await run(c), "answered");
  });

  it("fails without sending when the inbox refuses the token or is down, naming neither the token nor the address", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    for (const mode of ["forbidden", "boom", "drop"] as const) {
      platformMode = mode;
      await assert.rejects(run(c), refusal(/inbox/i, [TOKEN, platformOrigin, "internal details"]), mode);
    }
    assert.deepEqual(await outbound(c.id), []);
    assert.deepEqual((await replies()).map((r) => r.status), ["failed", "failed", "failed"]);
  });

  it("gives up quietly, without retrying, when the inbox says the conversation or the text is not valid", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    await pool!.query("delete from inbox.conversations where id = $1", [c.id]);
    assert.equal(await run({ id: c.id, ids: [1] }), "superseded", "a conversation that is gone has no customer message");
    const gone = await conversation(["in:hello"]);
    // The conversation exists for the reader but the inbox route says no: simulate with the route answering 404.
    platformMode = "not_found";
    assert.equal(await run(gone), "refused");
    assert.deepEqual((await replies()).map((r) => r.status), ["failed"]);
  });

  it("checks the inbox settings before asking the model", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    await settings.set("assistant", "inbox_url", "ftp://platform.example", "test");
    await assert.rejects(run(c), refusal(/inbox address/i, ["platform.example"]));
    await settings.set("assistant", "inbox_url", platformOrigin, "test");
    await settings.unset("assistant", "inbox_token", "test");
    await assert.rejects(run(c), refusal(/token/i, []));
    assert.equal(llmCalls.length, 0, "no model call is paid for when the answer could not be sent");
    assert.equal(platformCalls, 0);
  });
});

describe("answerMessage: customers who write while it works", { concurrency: false }, () => {
  const addCustomer = async (c: { id: number }, text: string) =>
    Number((await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', 'in', $2, 'received', $3) returning id", [c.id, text, NOW.toISOString()])).rows[0].id);

  it("throws its answer away and answers the newest message, with both in view, when one arrives while the model is thinking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:first question"]);
    llmHook = async (call) => { if (call === 1) await addCustomer(c, "second question"); };
    assert.equal(await run(c), "answered");
    assert.equal(llmCalls.length, 2);
    assert.deepEqual(llmCalls[1]!.body.messages.slice(1).map((m) => m.content), ["first question", "second question"]);
    assert.equal((await outbound(c.id)).length, 1, "only the answer to the newest message was sent");
    const rows = await replies();
    assert.deepEqual(rows.map((r) => [r.status, r.error]), [["failed", "superseded"], ["sent", null]]);
    const newest = (await pool!.query("select max(id) as id from inbox.messages where direction = 'in' and conversation_id = $1", [c.id])).rows[0].id;
    assert.equal(Number(rows[1].in_reply_to), Number(newest));
  });

  it("answers a message that arrives while its own reply is being sent", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:first question"]);
    platformHook = async (call) => { if (call === 1) await addCustomer(c, "and do you ship?"); };
    assert.equal(await run(c), "answered");
    assert.equal(llmCalls.length, 2);
    assert.equal((await outbound(c.id)).length, 2);
    assert.deepEqual((await replies()).map((r) => r.status), ["sent", "sent"]);
    // The customer's line arrived while the reply was being stored, so it comes first; the history follows the order of the inbox.
    assert.deepEqual(llmCalls[1]!.body.messages.slice(1).map((m) => m.content).slice(-2), ["and do you ship?", "We open at 9 on weekdays."]);
  });

  it("goes round at most three times when the customer keeps writing, and sends the last answer", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:one"]);
    llmHook = async (call) => { await addCustomer(c, `more ${call}`); };
    assert.equal(await run(c), "answered");
    assert.equal(llmCalls.length, 3);
    assert.equal((await outbound(c.id)).length, 1);
    assert.deepEqual((await replies()).map((r) => r.status), ["failed", "failed", "sent"]);
  });

  it("does not send what the model wrote if it was switched off while the model was thinking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    llmHook = async () => { await saveConfig({ ...CONFIG, enabled: false }); };
    assert.equal(await run(c), "disabled");
    assert.deepEqual(await outbound(c.id), []);
    assert.deepEqual((await replies()).map((r) => r.status), ["failed"]);
  });

  it("does not send it if the conversation was stopped by hand while the model was thinking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    llmHook = async () => { await pool!.query("insert into assistant.paused (conversation_id, reason) values ($1, 'manual')", [c.id]); };
    assert.equal(await run(c), "paused");
    assert.deepEqual(await outbound(c.id), []);
  });

  it("does not send it, and stops, if a person wrote while the model was thinking", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    llmHook = async () => { await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', 'out', 'Marta here', 'sent')", [c.id]); };
    assert.equal(await run(c), "human");
    assert.equal(await pausedReason(c.id), "human");
    assert.deepEqual((await outbound(c.id)).map((m) => m.text), ["Marta here"]);
  });
});

describe("answerMessage: resuming a stopped conversation", { concurrency: false }, () => {
  const latestId = async (id: number) => Number((await pool!.query("select max(id) as id from inbox.messages where conversation_id = $1", [id])).rows[0].id);
  const addCustomer = async (id: number, text: string) =>
    Number((await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', 'in', $2, 'received', $3) returning id", [id, text, NOW.toISOString()])).rows[0].id);

  it("answers again after a person's message stopped it and Resume was pressed, until a person writes again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello", "out:Marta here", "in:can I come tomorrow?"]);
    assert.equal(await run(c), "human");
    assert.equal(await resumeConversation(c.id, await latestId(c.id), NOW), true);
    const next = await addCustomer(c.id, "are you there?");
    assert.equal(await run({ id: c.id, ids: [next] }), "answered");
    assert.equal(await pausedReason(c.id), null);
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', 'out', 'Marta again', 'sent')", [c.id]);
    const later = await addCustomer(c.id, "thanks");
    assert.equal(await run({ id: c.id, ids: [later] }), "human");
  });

  it("starts the hourly count again when a stopped conversation is resumed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await saveConfig({ ...CONFIG, maxRepliesPerHour: 2 });
    const c = await conversation(["in:hello"]);
    await pool!.query("insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values ($1, 901, 'sent', $2), ($1, 902, 'sent', $3)", [c.id, "2026-10-23T11:20:00Z", "2026-10-23T11:45:00Z"]);
    assert.equal(await run(c), "limit");
    assert.equal(await resumeConversation(c.id, await latestId(c.id), NOW), true);
    const next = await addCustomer(c.id, "hello again");
    assert.equal(await run({ id: c.id, ids: [next] }), "answered");
  });

  it("counts a message a person tried to send even if its delivery failed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status, error) values ($1, 'web', 'out', 'Marta tried', 'failed', 'HTTP 500')", [c.id]);
    assert.equal(await run(c), "human");
  });
});

describe("the job", { concurrency: false }, () => {
  const ctx = (payload: unknown) => ({ moduleId: "assistant", jobName: "answer", jobId: 1, attempt: 1, payload, signal: new AbortController().signal });

  it("reads the event it is given and answers that message", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const c = await conversation(["in:hello"]);
    await answerJob(ctx({ event: { id: 1, type: "inbox.message.received", payload: { channel: "web", conversationId: c.id, messageId: c.ids[0] }, createdAt: NOW.toISOString() } }));
    assert.equal((await outbound(c.id)).length, 1);
  });

  it("ignores a payload that is not an event of the inbox", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const payload of [null, {}, { event: null }, { event: { payload: {} } }, { event: { payload: { conversationId: "x", messageId: 1 } } }]) {
      await answerJob(ctx(payload));
    }
    assert.equal(llmCalls.length, 0);
  });
});
