import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import inbox from "../../inbox/manifest.ts";
import { POST as receive } from "../../inbox/web/messages.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../inbox/", import.meta.url));

function registryOf(): Registry {
  const registry = new Registry();
  registry.registerCore();
  registry.register(inbox);
  return registry;
}

describe("migration 0002, over data that 0001 wrote", () => {
  it("gives each conversation the reference and name of its contact, unlinks it, drops the contacts table and keeps the messages", async (t) => {
    const scratch = await createScratchDatabase();
    if (!scratch.url) return t.skip(scratch.skipReason);
    const pool = createPool(scratch.url);
    const old = mkdtempSync(join(tmpdir(), "inbox-0001-"));
    try {
      mkdirSync(join(old, "migrations"));
      copyFileSync(join(MODULE_DIR, "migrations", "0001_init.sql"), join(old, "migrations", "0001_init.sql"));
      await migrate(pool, registryOf(), { moduleDirs: { inbox: old } });
      assert.notEqual((await pool.query("select to_regclass('inbox.contacts') as t")).rows[0].t, null, "0001 alone still has the contacts table");

      const ada = (await pool.query("insert into inbox.contacts (channel, ref, name) values ('web', 'c-1', 'Ada') returning id")).rows[0].id;
      const anon = (await pool.query("insert into inbox.contacts (channel, ref, name) values ('web', 'c-2', null) returning id")).rows[0].id;
      const grace = (await pool.query("insert into inbox.contacts (channel, ref, name) values ('whatsapp', '+57300', 'Grace') returning id")).rows[0].id;
      const thread = async (channel: string, ref: string, contact: string, unread: number) =>
        Number((await pool.query("insert into inbox.conversations (channel, thread_ref, contact_id, unread_count) values ($1, $2, $3, $4) returning id", [channel, ref, contact, unread])).rows[0].id);
      const one = await thread("web", "t-1", ada, 2);
      await thread("web", "t-2", ada, 0);
      await thread("web", "t-3", anon, 1);
      await thread("whatsapp", "t-4", grace, 5);
      await pool.query("insert into inbox.messages (conversation_id, channel, direction, text, status, provider_message_id) values ($1, 'web', 'in', 'hello', 'received', 'm-1'), ($1, 'web', 'out', 'hi Ada', 'sent', null)", [one]);

      await migrate(pool, registryOf(), { moduleDirs: { inbox: MODULE_DIR } });

      const rows = (await pool.query("select channel, thread_ref, contact_ref, contact_name, contact_id, unread_count from inbox.conversations order by id")).rows;
      assert.deepEqual(rows, [
        { channel: "web", thread_ref: "t-1", contact_ref: "c-1", contact_name: "Ada", contact_id: null, unread_count: 2 },
        { channel: "web", thread_ref: "t-2", contact_ref: "c-1", contact_name: "Ada", contact_id: null, unread_count: 0 },
        { channel: "web", thread_ref: "t-3", contact_ref: "c-2", contact_name: null, contact_id: null, unread_count: 1 },
        { channel: "whatsapp", thread_ref: "t-4", contact_ref: "+57300", contact_name: "Grace", contact_id: null, unread_count: 5 },
      ]);
      assert.equal((await pool.query("select to_regclass('inbox.contacts') as t")).rows[0].t, null);
      assert.deepEqual((await pool.query("select direction, text, status, provider_message_id from inbox.messages order by id")).rows, [
        { direction: "in", text: "hello", status: "received", provider_message_id: "m-1" },
        { direction: "out", text: "hi Ada", status: "sent", provider_message_id: null },
      ]);
      await assert.rejects(pool.query("insert into inbox.messages (conversation_id, channel, direction, text, status, provider_message_id) values ($1, 'web', 'in', 'dup', 'received', 'm-1')", [one]), /duplicate key|unique/, "the dedupe key survived");
      await assert.rejects(pool.query("insert into inbox.conversations (channel, thread_ref, contact_ref) values ('web', 't-1', 'x')"), /duplicate key|unique/, "one conversation per thread survived");
      await assert.rejects(pool.query("insert into inbox.conversations (channel, thread_ref) values ('web', 't-9')"), /null value|not-null/, "the reference is required");
      assert.equal((await pool.query("select count(*)::int as n from information_schema.table_constraints where table_schema = 'inbox' and table_name = 'conversations' and constraint_type = 'FOREIGN KEY'")).rows[0].n, 0, "no foreign key to anything");
    } finally {
      rmSync(old, { recursive: true, force: true });
      await pool.end();
      await scratch.drop();
    }
  });
});

describe("what the webhook keeps of the person", { concurrency: false }, () => {
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
    await migrate(pool, registryOf(), { moduleDirs: { inbox: MODULE_DIR } });
    await pool.query("insert into core.modules (id, state, installed_version) values ('inbox', 'enabled', $1)", [inbox.version]);
    registerModuleRuntime(pool, { current: registryOf() });
  });

  after(async () => {
    await pool?.end();
    await dropScratch?.();
  });

  beforeEach(async () => {
    if (skipReason) return;
    await pool!.query("delete from core.events");
    await pool!.query("delete from inbox.messages");
    await pool!.query("delete from inbox.conversations");
  });

  let counter = 0;
  const post = (over: Record<string, unknown>) =>
    receive(new Request("http://localhost/hooks/inbox/messages", { method: "POST", body: JSON.stringify({ channel: "web", threadRef: "t-1", messageId: `m-${(counter += 1)}`, text: "hello", ...over }) }));
  const people = async () => (await pool!.query("select thread_ref, contact_ref, contact_name, contact_id from inbox.conversations order by thread_ref")).rows;

  it("has no contacts table and no link to another module until something sets one", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await pool!.query("select to_regclass('inbox.contacts') as t")).rows[0].t, null);
    assert.equal((await post({ contact: { ref: "c-1", name: "Ada" } })).status, 200);
    assert.deepEqual(await people(), [{ thread_ref: "t-1", contact_ref: "c-1", contact_name: "Ada", contact_id: null }]);
  });

  it("takes the name from the first message that carries one and never overwrites it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post({ contact: { ref: "c-1" } });
    assert.equal((await people())[0]!.contact_name, null);
    await post({ contact: { ref: "c-1", name: "Ada" } });
    assert.equal((await people())[0]!.contact_name, "Ada");
    await post({ contact: { ref: "c-1", name: "Someone else" } });
    assert.equal((await people())[0]!.contact_name, "Ada");
  });

  it("starts a new thread of a person it already knows by name with that name, in the same channel only", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post({ threadRef: "t-1", contact: { ref: "c-1", name: "Ada" } });
    await post({ threadRef: "t-2", contact: { ref: "c-1" } });
    await post({ threadRef: "t-3", channel: "whatsapp", contact: { ref: "c-1" } });
    assert.deepEqual((await people()).map((p) => [p.thread_ref, p.contact_name]), [["t-1", "Ada"], ["t-2", "Ada"], ["t-3", null]]);
  });

  it("names the person after the thread when the message has no contact", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await post({ threadRef: "t-9" });
    assert.deepEqual(await people(), [{ thread_ref: "t-9", contact_ref: "t-9", contact_name: null, contact_id: null }]);
  });
});
