import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import inbox from "../../inbox/manifest.ts";
import { POST as readRoute } from "../../inbox/web/svc-read.ts";
import { POST as sendRoute } from "../../inbox/web/svc-send.ts";
import { GET as conversationsRoute } from "../../inbox/web/svc-conversations.ts";
import { GET as messagesRoute } from "../../inbox/web/svc-messages.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { SettingsService } from "@modunexo/core/settings-service";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));
const KEY = "k".repeat(40);

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
  await migrate(pool, registry, { moduleDirs: { inbox: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('inbox', 'enabled', $1)", [inbox.version]);
  registerModuleRuntime(pool, { current: registry });
  settings = new SettingsService(pool, registry, { masterKey: KEY });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  for (const table of ["core.events", "core.jobs", "inbox.messages", "inbox.conversations"]) await pool!.query(`delete from ${table}`);
  await settings.unset("inbox", "outbound_url", "test");
});

const BASE = "http://shell.test/svc/inbox";
const get = (path: string) => new Request(`${BASE}${path}`);
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const body = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T;
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);

/** A conversation with `texts` as its messages, oldest first, the even ones received and the odd ones sent; returns its id. */
async function conversation(thread: string, texts: string[], options: { name?: string | null; unread?: number; last?: string; contactId?: number | null } = {}): Promise<number> {
  const made = await pool!.query(
    "insert into inbox.conversations (channel, thread_ref, contact_ref, contact_name, contact_id, unread_count, last_message_at) values ('web', $1, $2, $3, $4, $5, $6) returning id",
    [thread, `c-${thread}`, options.name ?? null, options.contactId ?? null, options.unread ?? 0, options.last ?? "2026-10-21T10:00:00Z"],
  );
  const id = Number(made.rows[0].id);
  for (const [index, text] of texts.entries()) {
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', $2, $3, $4)", [id, index % 2 === 0 ? "in" : "out", text, index % 2 === 0 ? "received" : "sent"]);
  }
  return id;
}

describe("the inbox manifest declares the service API", () => {
  it("is version 0.3.0 and offers each route under the scope it needs, none of them public", () => {
    const checked = validateManifest(inbox);
    assert.equal(checked.version, "0.3.0");
    assert.deepEqual(checked.scopes?.map((s) => s.key), ["messages.read", "messages.write"]);
    const byPath = new Map(checked.pages?.map((page) => [page.path, page]));
    const routes: [string, string, string][] = [
      ["/svc/inbox/conversations", "GET", "messages.read"],
      ["/svc/inbox/messages", "GET", "messages.read"],
      ["/svc/inbox/messages/send", "POST", "messages.write"],
      ["/svc/inbox/conversations/read", "POST", "messages.write"],
    ];
    for (const [path, method, scope] of routes) {
      assert.deepEqual(byPath.get(path)?.methods, [method], path);
      assert.equal(byPath.get(path)?.scope, scope, path);
    }
    assert.equal(byPath.get("/hooks/inbox/messages")?.public !== undefined, true, "the webhook is the only public route");
    assert.equal(checked.pages?.filter((page) => page.public !== undefined).length, 1);
  });
});

describe("GET /svc/inbox/conversations", { concurrency: false }, () => {
  it("lists the most recent activity first, with the person, the unread count and the last text", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const old = await conversation("old", ["first"], { name: "Old", last: "2026-10-20T10:00:00Z" });
    const fresh = await conversation("new", ["hi", "hello there"], { name: "New", unread: 2, last: "2026-10-21T11:00:00Z", contactId: 42 });
    const out = await body<{ conversations: Record<string, unknown>[] }>(await conversationsRoute(get("/conversations")));
    assert.deepEqual(out.conversations, [
      { id: fresh, channel: "web", contactRef: "c-new", contactName: "New", contactId: 42, unread: 2, lastMessageAt: "2026-10-21T11:00:00.000Z", lastText: "hello there" },
      { id: old, channel: "web", contactRef: "c-old", contactName: "Old", contactId: null, unread: 0, lastMessageAt: "2026-10-20T10:00:00.000Z", lastText: "first" },
    ]);
  });

  it("keeps only the conversations with unread messages when asked, and cuts at limit", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await conversation("a", ["x"], { unread: 0 });
    const b = await conversation("b", ["y"], { unread: 3, last: "2026-10-21T12:00:00Z" });
    const only = await body<{ conversations: { id: number }[] }>(await conversationsRoute(get("/conversations?unread=true")));
    assert.deepEqual(only.conversations.map((c) => c.id), [b]);
    const all = await body<{ conversations: unknown[] }>(await conversationsRoute(get("/conversations?unread=false")));
    assert.equal(all.conversations.length, 2);
    assert.equal((await body<{ conversations: unknown[] }>(await conversationsRoute(get("/conversations?limit=1")))).conversations.length, 1);
  });

  it("answers 50 by default, and 400 for a limit outside 1 to 100 or an unread value that is not true or false", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_ref) select 'web', 't' || n, 'c' || n from generate_series(1, 60) n");
    assert.equal((await body<{ conversations: unknown[] }>(await conversationsRoute(get("/conversations")))).conversations.length, 50);
    for (const query of ["limit=0", "limit=101", "limit=abc", "limit=-1", "unread=yes", "unread=1"]) assert.equal((await conversationsRoute(get(`/conversations?${query}`))).status, 400, query);
  });
});

describe("GET /svc/inbox/messages", { concurrency: false }, () => {
  it("answers the conversation and its messages oldest first, with the status of each, and does not mark them read", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["one", "two", "three"], { name: "Ada", unread: 2 });
    const out = await body<{ conversation: Record<string, unknown>; messages: Record<string, unknown>[] }>(await messagesRoute(get(`/messages?conversationId=${id}`)));
    assert.equal(out.conversation.contactName, "Ada");
    assert.equal(out.conversation.unread, 2);
    assert.deepEqual(out.messages.map((m) => [m.direction, m.text, m.status, m.error]), [["in", "one", "received", null], ["out", "two", "sent", null], ["in", "three", "received", null]]);
    assert.equal(typeof out.messages[0]!.id, "number");
    assert.equal(Number.isNaN(Date.parse(out.messages[0]!.createdAt as string)), false);
    assert.equal(Number((await pool!.query("select unread_count from inbox.conversations where id = $1", [id])).rows[0].unread_count), 2, "reading by service leaves the unread count alone");
  });

  it("returns the newest limit messages, 100 by default, still oldest first", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("long", []);
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) select $1, 'web', 'in', 'm' || n, 'received' from generate_series(1, 120) n", [id]);
    const standard = await body<{ messages: { text: string }[] }>(await messagesRoute(get(`/messages?conversationId=${id}`)));
    assert.equal(standard.messages.length, 100);
    assert.deepEqual([standard.messages[0]!.text, standard.messages[99]!.text], ["m21", "m120"]);
    const few = await body<{ messages: { text: string }[] }>(await messagesRoute(get(`/messages?conversationId=${id}&limit=3`)));
    assert.deepEqual(few.messages.map((m) => m.text), ["m118", "m119", "m120"]);
  });

  it("with afterId returns what came after that message, oldest first, up to limit", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["a", "b", "c", "d", "e"]);
    const ids = (await pool!.query("select id from inbox.messages where conversation_id = $1 order by id", [id])).rows.map((r) => Number(r.id));
    const after = await body<{ messages: { text: string }[] }>(await messagesRoute(get(`/messages?conversationId=${id}&afterId=${ids[1]}`)));
    assert.deepEqual(after.messages.map((m) => m.text), ["c", "d", "e"]);
    const capped = await body<{ messages: { text: string }[] }>(await messagesRoute(get(`/messages?conversationId=${id}&afterId=${ids[1]}&limit=2`)));
    assert.deepEqual(capped.messages.map((m) => m.text), ["c", "d"]);
    const none = await body<{ messages: unknown[] }>(await messagesRoute(get(`/messages?conversationId=${id}&afterId=${ids[4]}`)));
    assert.deepEqual(none.messages, []);
  });

  it("answers 404 for an unknown conversation and 400 for values it cannot use", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["a"]);
    assert.equal((await messagesRoute(get("/messages?conversationId=424242"))).status, 404);
    for (const query of ["", "?conversationId=x", "?conversationId=0", `?conversationId=${id}&limit=0`, `?conversationId=${id}&limit=201`, `?conversationId=${id}&afterId=x`, `?conversationId=${id}&afterId=-1`]) {
      assert.equal((await messagesRoute(get(`/messages${query}`))).status, 400, query);
    }
  });
});

describe("POST /svc/inbox/messages/send", { concurrency: false }, () => {
  it("stores the reply as queued and answers 201; with no outbound URL nothing is queued for delivery", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["hello"], { unread: 1 });
    const response = await sendRoute(post("/messages/send", { conversationId: id, text: "  Hi there  " }));
    assert.equal(response.status, 201);
    const out = await body<{ id: number; status: string }>(response);
    assert.equal(out.status, "queued");
    const row = (await pool!.query("select direction, text, status from inbox.messages where id = $1", [out.id])).rows[0];
    assert.deepEqual(row, { direction: "out", text: "Hi there", status: "queued" });
    assert.equal(await count("core.jobs"), 0);
    assert.equal(Number((await pool!.query("select unread_count from inbox.conversations where id = $1", [id])).rows[0].unread_count), 1, "sending leaves the unread count alone, like the form");
  });

  it("queues the delivery job when an outbound URL is set", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.set("inbox", "outbound_url", "https://provider.example/in", "test");
    const id = await conversation("t", ["hello"]);
    const out = await body<{ id: number }>(await sendRoute(post("/messages/send", { conversationId: id, text: "ok" })));
    const jobs = (await pool!.query("select name, payload, dedupe_key from core.jobs where module_id = 'inbox' and name = 'deliver'")).rows;
    assert.deepEqual(jobs, [{ name: "deliver", payload: { messageId: out.id }, dedupe_key: `deliver:${out.id}` }]);
  });

  it("answers 404 for an unknown conversation and 400 for a text or an id it cannot use, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["hello"]);
    const before = await count("inbox.messages");
    assert.equal((await sendRoute(post("/messages/send", { conversationId: 424242, text: "x" }))).status, 404);
    for (const bad of [{ conversationId: id }, { conversationId: id, text: "   " }, { conversationId: id, text: "x".repeat(4001) }, { conversationId: id, text: "a\u0000b" }, { conversationId: "x", text: "hi" }, { text: "hi" }, "not json", "[]", { conversationId: id, text: 5 }]) {
      assert.equal((await sendRoute(post("/messages/send", bad))).status, 400, JSON.stringify(bad));
    }
    assert.equal((await sendRoute(post("/messages/send", { conversationId: id, text: "n".repeat(20_000) }))).status, 413);
    assert.equal(await count("inbox.messages"), before);
  });
});

describe("POST /svc/inbox/conversations/read", { concurrency: false }, () => {
  it("clears the unread count of that conversation only", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const a = await conversation("a", ["x"], { unread: 4 });
    await conversation("b", ["y"], { unread: 2 });
    const response = await readRoute(post("/conversations/read", { conversationId: a }));
    assert.equal(response.status, 200);
    assert.deepEqual(await body(response), { ok: true });
    assert.deepEqual((await pool!.query("select thread_ref, unread_count from inbox.conversations order by thread_ref")).rows, [{ thread_ref: "a", unread_count: 0 }, { thread_ref: "b", unread_count: 2 }]);
  });

  it("answers 404 for an unknown conversation and 400 for an id it cannot use", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await readRoute(post("/conversations/read", { conversationId: 424242 }))).status, 404);
    for (const bad of [{}, { conversationId: "x" }, { conversationId: 0 }, "nope"]) assert.equal((await readRoute(post("/conversations/read", bad))).status, 400, JSON.stringify(bad));
  });
});
