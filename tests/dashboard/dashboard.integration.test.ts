import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import { DashboardService } from "@modunexo/core/dashboard";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import agenda from "../../agenda/manifest.ts";
import assistant from "../../assistant/manifest.ts";
import contacts from "../../contacts/manifest.ts";
import inbox from "../../inbox/manifest.ts";

const MODULES = [contacts, agenda, inbox, assistant];
const dir = (id: string) => fileURLToPath(new URL(`../../${id}/`, import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let service: DashboardService;

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
  for (const manifest of MODULES) registry.register(manifest);
  await migrate(pool, registry, { moduleDirs: Object.fromEntries(MODULES.map((manifest) => [manifest.id, dir(manifest.id)])) });
  for (const manifest of MODULES) await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', $2)", [manifest.id, manifest.version]);
  service = new DashboardService(pool, registry);
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("delete from contacts.contacts");
  await pool!.query("delete from agenda.bookings");
  await pool!.query("delete from inbox.conversations");
  await pool!.query("delete from assistant.replies");
  await pool!.query("delete from assistant.paused");
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (skipReason) return t.skip(skipReason);
    await run();
  });

const sql = async (text: string, params: unknown[] = []) => (await pool!.query(text, params)).rows;
const stat = async (moduleId: string, key: string) => (await service.cards(() => true)).stats.find((card) => card.moduleId === moduleId && card.key === key)?.value;
const alert = async (moduleId: string, key: string) => (await service.cards(() => true)).alerts.find((card) => card.moduleId === moduleId && card.key === key);

describe("every module reports to the dashboard", () => {
  for (const manifest of MODULES) {
    it(`${manifest.id} declares figures or alerts, and each one is behind a permission the module declares`, () => {
      const checked = validateManifest(manifest);
      const entries = [...(checked.dashboard?.stats ?? []), ...(checked.dashboard?.alerts ?? [])];
      assert.ok(entries.length >= 1, "a module of this repository declares a dashboard");
      for (const entry of entries) assert.ok(entry.permission !== undefined, `${entry.key} names the permission that lets someone see it`);
    });
  }

  guard("every declared statement runs against the module's real tables: nothing is 'not available' on an empty database", async () => {
    const { stats, alerts } = await service.cards(() => true);
    assert.deepEqual(stats.filter((card) => card.value === null).map((card) => `${card.moduleId}.${card.key}`), []);
    assert.deepEqual(alerts.filter((card) => card.count === null).map((card) => `${card.moduleId}.${card.key}`), []);
    for (const manifest of MODULES) {
      const declared = manifest.dashboard?.stats?.length ?? 0;
      assert.equal(stats.filter((card) => card.moduleId === manifest.id).length, declared, `${manifest.id} figures`);
    }
  });

  guard("a viewer without the permissions sees nothing from any module", async () => {
    const cards = await service.cards((_id, permission) => permission === undefined);
    assert.deepEqual([cards.stats.length, cards.alerts.length], [0, 0]);
  });
});

describe("contacts", { concurrency: false }, () => {
  guard("counts the people and the open leads with their value, and warns about open leads not moved for a week", async () => {
    const [ada, grace] = [
      Number((await sql("insert into contacts.contacts (name) values ('Ada') returning id"))[0].id),
      Number((await sql("insert into contacts.contacts (name) values ('Grace') returning id"))[0].id),
    ];
    const stage = async (name: string) => Number((await sql("select id from contacts.pipeline_stages where name = $1", [name]))[0].id);
    const lead = (contact: number, stageId: number, amount: number, age: string) =>
      sql(`insert into contacts.leads (contact_id, stage_id, title, amount, updated_at) values ($1, $2, 'L', $3, now() - interval '${age}')`, [contact, stageId, amount]);
    await lead(ada, await stage("New"), 1000.4, "1 day");
    await lead(ada, await stage("Qualified"), 500.4, "10 days");
    await lead(grace, await stage("Won"), 9999, "30 days");
    assert.equal(await stat("contacts", "people"), 2);
    assert.equal(await stat("contacts", "open_leads"), 2);
    assert.equal(await stat("contacts", "open_value"), 1501, "only open leads, rounded");
    const stale = await alert("contacts", "stale_leads");
    assert.deepEqual([stale?.count, stale?.severity, stale?.href], [1, "warning", "/pipeline"]);
  });

  guard("has no stale alert while every open lead moved this week", async () => {
    const id = Number((await sql("insert into contacts.contacts (name) values ('Ada') returning id"))[0].id);
    await sql("insert into contacts.leads (contact_id, stage_id, title) select $1, id, 'L' from contacts.pipeline_stages where name = 'New'", [id]);
    assert.equal(await alert("contacts", "stale_leads"), undefined);
  });
});

describe("agenda", { concurrency: false }, () => {
  guard("counts today's bookings in the agenda's timezone and the bookings still to come, ignoring cancelled ones", async () => {
    await sql("update agenda.settings set timezone = 'UTC'");
    const booking = (starts: string, status = "booked") =>
      sql(`insert into agenda.bookings (starts_at, ends_at, status, attendee_name) values (${starts}, ${starts} + interval '30 minutes', $1, 'Ada')`, [status]);
    await booking("date_trunc('day', now()) + interval '1 minute'");
    await booking("date_trunc('day', now()) + interval '2 minutes'", "cancelled");
    await booking("now() + interval '2 days'");
    await booking("now() - interval '3 days'");
    assert.equal(await stat("agenda", "today"), 1);
    assert.equal(await stat("agenda", "upcoming"), await upcoming());
  });

  guard("warns that nobody can book while no opening hours are set, and not while there are some", async () => {
    assert.equal(await alert("agenda", "no_hours"), undefined, "the module ships with hours");
    await sql("delete from agenda.weekly_hours");
    const warning = await alert("agenda", "no_hours");
    assert.deepEqual([warning?.count, warning?.severity, warning?.href], [1, "warning", "/agenda/settings"]);
  });
});

async function upcoming(): Promise<number> {
  return Number((await sql("select count(*) as n from agenda.bookings where status = 'booked' and starts_at >= now()"))[0].n);
}

describe("inbox", { concurrency: false }, () => {
  const conversation = async (unread: number, lastMessageAge: string) =>
    Number(
      (await sql(
        `insert into inbox.conversations (channel, thread_ref, contact_ref, unread_count, last_message_at) values ('web', $1, 'c', $2, now() - interval '${lastMessageAge}') returning id`,
        [`t-${Math.random()}`, unread],
      ))[0].id,
    );
  const message = (conversationId: number, direction: string, status: string, age: string) =>
    sql(`insert into inbox.messages (conversation_id, channel, direction, text, status, created_at) values ($1, 'web', $2, 'hi', $3, now() - interval '${age}')`, [conversationId, direction, status]);

  guard("counts conversations, unread ones and the messages of the last day", async () => {
    const first = await conversation(2, "5 minutes");
    await conversation(0, "5 minutes");
    await message(first, "in", "received", "1 hour");
    await message(first, "in", "received", "3 days");
    assert.equal(await stat("inbox", "conversations"), 2);
    assert.equal(await stat("inbox", "unread"), 1);
    assert.equal(await stat("inbox", "recent_messages"), 1);
  });

  guard("warns about unread conversations that have waited over an hour", async () => {
    await conversation(1, "5 minutes");
    await conversation(3, "2 hours");
    await conversation(0, "5 hours");
    const waiting = await alert("inbox", "waiting");
    assert.deepEqual([waiting?.count, waiting?.severity, waiting?.href], [1, "warning", "/inbox"]);
  });

  guard("raises an error alert for replies that failed to send in the last week, and not for an old one or a sent one", async () => {
    const id = await conversation(0, "1 minute");
    await message(id, "out", "failed", "1 hour");
    await message(id, "out", "failed", "30 days");
    await message(id, "out", "sent", "1 hour");
    const failed = await alert("inbox", "failed_replies");
    assert.deepEqual([failed?.count, failed?.severity], [1, "error"]);
  });
});

describe("assistant", { concurrency: false }, () => {
  // One sent reply per customer message is a rule of the table, so each row answers a message of its own.
  let next = 0;
  const reply = (status: string, age: string) =>
    sql(`insert into assistant.replies (conversation_id, in_reply_to, status, created_at) values (1, $2, $1, now() - interval '${age}')`, [status, ++next]);

  guard("counts the replies of the last day and the conversations it stopped", async () => {
    await reply("sent", "1 hour");
    await reply("sent", "3 days");
    await reply("failed", "1 hour");
    await sql("insert into assistant.paused (conversation_id, reason) values (7, 'human'), (8, 'handoff')");
    assert.equal(await stat("assistant", "replies"), 1);
    assert.equal(await stat("assistant", "stopped"), 2);
  });

  guard("raises an error alert for replies that failed today", async () => {
    assert.equal(await alert("assistant", "failed_replies"), undefined);
    await reply("failed", "2 hours");
    await reply("failed", "3 days");
    const failed = await alert("assistant", "failed_replies");
    assert.deepEqual([failed?.count, failed?.severity, failed?.href], [1, "error", "/assistant"]);
  });

  guard("says the assistant is switched off while it is, and says nothing once it is on", async () => {
    await sql("update assistant.config set enabled = false");
    const off = await alert("assistant", "switched_off");
    assert.deepEqual([off?.count, off?.severity, off?.href], [1, "info", "/assistant/settings"]);
    await sql("update assistant.config set enabled = true");
    assert.equal(await alert("assistant", "switched_off"), undefined);
    await sql("update assistant.config set enabled = false");
  });
});
