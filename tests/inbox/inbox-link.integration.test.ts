import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import linkContact from "../../inbox/jobs/link-contact.ts";
import inbox from "../../inbox/manifest.ts";
import { POST as receive } from "../../inbox/web/messages.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { SettingsService } from "@modunexo/core/settings-service";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));
const KEY = "k".repeat(40);
const TOKEN = "mdnx_abcd1234_the-contacts-token-0123456789abcdefghijk";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let settings: SettingsService;
let server: Server;
let origin: string;

type Seen = { method: string; url: string; auth: string | undefined; body: string };
let seen: Seen[] = [];
let known = new Map<string, number>();
let nextId = 100;
let mode: "ok" | "down" | "redirect" = "ok";

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
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const json = (status: number, value: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (mode === "down") return json(500, { error: "provider says no" });
      if (mode === "redirect") {
        res.statusCode = 302;
        res.setHeader("location", "http://127.0.0.1:1/elsewhere");
        return res.end();
      }
      const url = new URL(req.url ?? "", "http://x");
      if (req.method === "GET" && url.pathname === "/svc/contacts/contact") {
        const id = known.get(url.searchParams.get("identity") ?? "");
        return id === undefined ? json(404, { error: "not_found" }) : json(200, { id });
      }
      if (req.method === "POST" && url.pathname === "/svc/contacts/contacts/create") {
        const given = JSON.parse(body) as { name: string; identity: string };
        const id = known.get(given.identity);
        if (id !== undefined) return json(409, { error: "identity_taken", id });
        nextId += 1;
        known.set(given.identity, nextId);
        return json(201, { id: nextId, name: given.name, identity: given.identity });
      }
      return json(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  seen = [];
  known = new Map();
  nextId = 100;
  mode = "ok";
  for (const table of ["core.events", "core.jobs", "inbox.messages", "inbox.conversations"]) await pool!.query(`delete from ${table}`);
  await settings.set("inbox", "contacts_url", origin, "test");
  await settings.set("inbox", "contacts_token", TOKEN, "test");
});

let counter = 0;
const post = (over: Record<string, unknown> = {}) =>
  receive(new Request("http://localhost/hooks/inbox/messages", { method: "POST", body: JSON.stringify({ channel: "web", threadRef: "t-1", messageId: `m-${(counter += 1)}`, text: "hello", contact: { ref: "c-1", name: "Ada" }, ...over }) }));
const jobs = async () => (await pool!.query("select name, payload, dedupe_key from core.jobs where module_id = 'inbox' and name = 'link_contact' order by id")).rows;
const conversation = async (thread = "t-1") => (await pool!.query("select id, contact_id from inbox.conversations where thread_ref = $1", [thread])).rows[0] as { id: string; contact_id: string | null };
const ctx = (conversationId: number, attempt = 1) => ({ moduleId: "inbox", jobName: "link_contact", jobId: 1, attempt, payload: { conversationId }, signal: new AbortController().signal });
const insertConversation = async (over: { contact_id?: number | null; name?: string | null; ref?: string } = {}) =>
  Number((await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_ref, contact_name, contact_id) values ('web', 't-1', $1, $2, $3) returning id", [over.ref ?? "c-1", over.name === undefined ? "Ada" : over.name, over.contact_id ?? null])).rows[0].id);

describe("the manifest", () => {
  it("declares the contacts address and token as settings, the job, and stays valid", () => {
    const checked = validateManifest(inbox);
    assert.equal(checked.version, "0.3.0");
    assert.equal(checked.settings?.find((s) => s.key === "contacts_url")?.type, "string");
    assert.equal(checked.settings?.find((s) => s.key === "contacts_token")?.type, "secret");
    assert.equal(checked.settings?.find((s) => s.key === "contacts_url")?.required, undefined, "the link is optional");
    assert.deepEqual(checked.jobs?.find((j) => j.name === "link_contact")?.maxAttempts, 5);
  });
});

describe("asking for the link when a message arrives", { concurrency: false }, () => {
  it("enqueues nothing while the contacts address or token is missing, and the webhook still answers 200", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.unset("inbox", "contacts_token", "test");
    assert.equal((await post()).status, 200);
    assert.deepEqual(await jobs(), []);
    await settings.set("inbox", "contacts_token", TOKEN, "test");
    await settings.unset("inbox", "contacts_url", "test");
    assert.equal((await post({ messageId: "other" })).status, 200);
    assert.deepEqual(await jobs(), []);
  });

  it("enqueues one job for the conversation, and not another while that one is waiting", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post();
    await post();
    await post();
    const { id } = await conversation();
    const queued = await jobs();
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].payload, { conversationId: Number(id) });
    assert.equal(queued[0].dedupe_key, `link:${id}`);
  });

  it("does not enqueue for a duplicate message, nor for a conversation that is already linked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post({ messageId: "same" });
    await pool!.query("delete from core.jobs");
    await post({ messageId: "same" });
    assert.deepEqual(await jobs(), [], "a duplicate changes nothing");
    await pool!.query("update inbox.conversations set contact_id = 7");
    await post({ messageId: "fresh" });
    assert.deepEqual(await jobs(), [], "already linked");
  });
});

describe("the link_contact job", { concurrency: false }, () => {
  it("stores the id of a contact that already holds the identity, looked up with the token, and creates nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    known.set("web:c-1", 42);
    const id = await insertConversation();
    await linkContact(ctx(id));
    assert.equal(Number((await conversation()).contact_id), 42);
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]!.method, seen[0]!.url, seen[0]!.auth], ["GET", `/svc/contacts/contact?identity=${encodeURIComponent("web:c-1")}`, `Bearer ${TOKEN}`]);
  });

  it("creates the contact with the name it has seen, named by the channel and reference, when nobody holds the identity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertConversation();
    await linkContact(ctx(id));
    assert.equal(seen.length, 2);
    assert.deepEqual([seen[1]!.method, seen[1]!.url, seen[1]!.auth], ["POST", "/svc/contacts/contacts/create", `Bearer ${TOKEN}`]);
    assert.deepEqual(JSON.parse(seen[1]!.body), { name: "Ada", identity: "web:c-1" });
    assert.equal(Number((await conversation()).contact_id), 101);
  });

  it("uses the reference as the name when the person has none", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertConversation({ name: null, ref: "+57300" });
    await linkContact(ctx(id));
    assert.deepEqual(JSON.parse(seen[1]!.body), { name: "+57300", identity: "web:+57300" });
  });

  it("takes the id from an identity conflict, which is what happens when two conversations of the person race", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertConversation();
    // The lookup says nobody has it; by the time of the create, somebody does.
    const originalGet = known.get.bind(known);
    let first = true;
    known.get = (key: string) => {
      if (first && key === "web:c-1") {
        first = false;
        known.set(key, 77);
        return undefined;
      }
      return originalGet(key);
    };
    try {
      await linkContact(ctx(id));
    } finally {
      known.get = originalGet;
    }
    assert.equal(Number((await conversation()).contact_id), 77);
  });

  it("does nothing for a conversation that is gone or already linked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await linkContact(ctx(424242));
    const id = await insertConversation({ contact_id: 5 });
    await linkContact(ctx(id));
    assert.deepEqual(seen, []);
    assert.equal(Number((await conversation()).contact_id), 5);
  });

  it("does nothing when the link was switched off after the job was queued", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await insertConversation();
    await settings.unset("inbox", "contacts_url", "test");
    await linkContact(ctx(id));
    assert.deepEqual(seen, []);
    assert.equal((await conversation()).contact_id, null);
  });

  it("fails, so that the job is retried, when the contacts service answers an error, and the message names neither the address nor the token nor the answer", async (t) => {
    if (skipReason) return t.skip(skipReason);
    mode = "down";
    const id = await insertConversation();
    await assert.rejects(linkContact(ctx(id)), (error: Error) => {
      assert.match(error.message, /HTTP 500/);
      for (const secret of [origin, TOKEN, "provider says no"]) assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal((await conversation()).contact_id, null);
  });

  it("does not follow a redirect with the token in its hands", async (t) => {
    if (skipReason) return t.skip(skipReason);
    mode = "redirect";
    const id = await insertConversation();
    await assert.rejects(linkContact(ctx(id)), (error: Error) => {
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
    assert.equal(seen.length, 1, "one request, no hop");
  });

  it("refuses an address that is not http or https before sending anything", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.set("inbox", "contacts_url", "ftp://contacts.example", "test");
    const id = await insertConversation();
    await assert.rejects(linkContact(ctx(id)), (error: Error) => {
      assert.equal(error.message.includes("contacts.example"), false);
      return true;
    });
    assert.deepEqual(seen, []);
  });

  it("works with an address that ends in a slash", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.set("inbox", "contacts_url", `${origin}/`, "test");
    known.set("web:c-1", 9);
    const id = await insertConversation();
    await linkContact(ctx(id));
    assert.equal(Number((await conversation()).contact_id), 9);
    assert.equal(seen[0]!.url.startsWith("/svc/contacts/contact?"), true);
  });
});
