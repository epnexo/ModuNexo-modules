import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { addStage, createLead, leadHistory, leadInput, leadsOfContact, listStages, loadBoard, moveLead, renameStage, stageName } from "../../contacts/lib/pipeline.ts";
import contacts from "../../contacts/manifest.ts";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";

const MODULE_DIR = fileURLToPath(new URL("../../contacts/", import.meta.url));

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
  registry.register(contacts);
  await migrate(pool, registry, { moduleDirs: { contacts: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('contacts', 'enabled', $1)", [contacts.version]);
  registerModuleRuntime(pool, { current: registry });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

/** Every test starts from the five stages the migration creates, no contact, no lead and no event. */
beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("delete from core.events");
  await pool!.query("delete from contacts.contacts");
  const seeded = (await pool!.query("select id from contacts.pipeline_stages order by id limit 5")).rows.map((row) => Number(row.id));
  await pool!.query("delete from contacts.pipeline_stages where id <> all($1::bigint[])", [seeded]);
  const original: [string, number, string][] = [["New", 1, "open"], ["Contacted", 2, "open"], ["Qualified", 3, "open"], ["Won", 4, "won"], ["Lost", 5, "lost"]];
  for (const [index, [name, position, kind]] of original.entries()) await pool!.query("update contacts.pipeline_stages set name = $2, position = $3, kind = $4 where id = $1", [seeded[index], name, position, kind]);
});

const events = async () => (await pool!.query("select type, payload from core.events order by id")).rows as { type: string; payload: Record<string, unknown> }[];
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const contact = async (name = "Ada") => Number((await pool!.query("insert into contacts.contacts (name) values ($1) returning id", [name])).rows[0].id);
const stageId = async (name: string) => Number((await pool!.query("select id from contacts.pipeline_stages where name = $1", [name])).rows[0].id);
const lead = async (contactId: number, title = "Deal") => {
  const checked = leadInput({ contactId: String(contactId), title });
  assert.ok(checked.ok, JSON.stringify(checked));
  const made = await createLead(checked.value);
  assert.ok(made.ok, JSON.stringify(made));
  return made.id;
};

describe("the stages", { concurrency: false }, () => {
  it("start as New, Contacted, Qualified, Won and Lost, in that order, with Won and Lost as closing stages", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const stages = await listStages();
    assert.deepEqual(stages.map((s) => [s.name, s.position, s.kind]), [["New", 1, "open"], ["Contacted", 2, "open"], ["Qualified", 3, "open"], ["Won", 4, "won"], ["Lost", 5, "lost"]]);
  });

  it("add a stage just before the first closing one and keep the order of the rest", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const added = await addStage("Proposal");
    assert.equal(added.ok, true);
    const stages = await listStages();
    assert.deepEqual(stages.map((s) => [s.name, s.position, s.kind]), [["New", 1, "open"], ["Contacted", 2, "open"], ["Qualified", 3, "open"], ["Proposal", 4, "open"], ["Won", 5, "won"], ["Lost", 6, "lost"]]);
    assert.ok(added.ok && stages.some((s) => s.id === added.id && s.name === "Proposal"));
  });

  it("add two stages one after the other, the second after the first", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await addStage("Proposal");
    await addStage("Negotiation");
    assert.deepEqual((await listStages()).map((s) => s.name), ["New", "Contacted", "Qualified", "Proposal", "Negotiation", "Won", "Lost"]);
  });

  it("are renamed without changing their kind or place, and a stage that does not exist is not_found", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const won = await stageId("Won");
    assert.deepEqual(await renameStage(won, "Closed won"), { ok: true });
    const row = (await listStages()).find((s) => s.id === won);
    assert.deepEqual([row?.name, row?.position, row?.kind], ["Closed won", 4, "won"]);
    assert.deepEqual(await renameStage(424242, "x"), { ok: false, error: "not_found" });
  });

  it("need a name of 1 to 80 characters without a NUL", () => {
    assert.deepEqual(stageName("  Proposal "), { ok: true, value: "Proposal" });
    for (const raw of [undefined, "", "   ", "x".repeat(81), "a\u0000b", 3]) assert.equal(stageName(raw).ok, false, String(raw));
    assert.equal(stageName("x".repeat(80)).ok, true);
  });
});

describe("leadInput", () => {
  it("reads the contact, the title, the amount and the priority from the fields of a form", () => {
    const checked = leadInput({ contactId: "12", title: "  Website  ", amount: "1200.50", priority: "high" });
    assert.deepEqual(checked, { ok: true, value: { contactId: 12, title: "Website", amount: 1200.5, priority: "high" } });
  });

  it("defaults the priority to normal and a blank amount to null", () => {
    assert.deepEqual(leadInput({ contactId: "1", title: "A", amount: "  " }), { ok: true, value: { contactId: 1, title: "A", amount: null, priority: "normal" } });
  });

  it("refuses a bad contact id, a blank or long title, a negative or malformed amount and an unknown priority", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["contactId", { contactId: "abc", title: "A" }],
      ["contactId", { contactId: "", title: "A" }],
      ["contactId", { contactId: "1".repeat(16), title: "A" }],
      ["title", { contactId: "1", title: "  " }],
      ["title", { contactId: "1", title: "x".repeat(201) }],
      ["title", { contactId: "1", title: "a\u0000" }],
      ["amount", { contactId: "1", title: "A", amount: "-5" }],
      ["amount", { contactId: "1", title: "A", amount: "12.345" }],
      ["amount", { contactId: "1", title: "A", amount: "ten" }],
      ["amount", { contactId: "1", title: "A", amount: "1e3" }],
      ["amount", { contactId: "1", title: "A", amount: "1000000000000" }],
      ["priority", { contactId: "1", title: "A", priority: "urgent" }],
    ];
    for (const [field, raw] of bad) {
      const checked = leadInput(raw);
      assert.equal(checked.ok, false, JSON.stringify(raw));
      if (!checked.ok) assert.match(checked.error, new RegExp(`"${field}"`));
    }
  });
});

describe("createLead", { concurrency: false }, () => {
  it("puts the lead in the first stage with a first history row, and announces nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact();
    const checked = leadInput({ contactId: String(id), title: "Website", amount: "300", priority: "low" });
    assert.ok(checked.ok);
    const made = await createLead(checked.value);
    assert.ok(made.ok);
    const row = (await pool!.query("select title, amount, priority, closed_at, s.name as stage from contacts.leads l join contacts.pipeline_stages s on s.id = l.stage_id where l.id = $1", [made.id])).rows[0];
    assert.deepEqual([row.title, Number(row.amount), row.priority, row.closed_at, row.stage], ["Website", 300, "low", null, "New"]);
    assert.deepEqual(await leadHistory(made.id), [{ from: null, to: "New", at: (await leadHistory(made.id))[0]!.at }]);
    assert.deepEqual(await events(), []);
  });

  it("says contact_not_found for a contact that does not exist and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const checked = leadInput({ contactId: "424242", title: "Ghost" });
    assert.ok(checked.ok);
    assert.deepEqual(await createLead(checked.value), { ok: false, error: "contact_not_found" });
    assert.equal(await count("contacts.leads"), 0);
  });
});

describe("moveLead", { concurrency: false }, () => {
  it("changes the stage, writes a history row and announces lead.stage_changed once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const contactId = await contact();
    const id = await lead(contactId);
    await pool!.query("delete from core.events");
    const from = await stageId("New");
    const to = await stageId("Qualified");
    assert.deepEqual(await moveLead(id, to), { ok: true, changed: true });
    assert.equal(Number((await pool!.query("select stage_id from contacts.leads where id = $1", [id])).rows[0].stage_id), to);
    assert.deepEqual((await leadHistory(id)).map((h) => [h.from, h.to]), [[null, "New"], ["New", "Qualified"]]);
    assert.deepEqual(await events(), [{ type: "contacts.lead.stage_changed", payload: { leadId: id, contactId, fromStageId: from, toStageId: to, toKind: "open" } }]);
  });

  it("does nothing, and announces nothing, when the lead is already in that stage", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await lead(await contact());
    await pool!.query("delete from core.events");
    assert.deepEqual(await moveLead(id, await stageId("New")), { ok: true, changed: false });
    assert.equal((await leadHistory(id)).length, 1);
    assert.deepEqual(await events(), []);
  });

  it("sets closed_at in a closing stage and clears it when the lead goes back to an open one", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await lead(await contact());
    const closedAt = async () => (await pool!.query("select closed_at from contacts.leads where id = $1", [id])).rows[0].closed_at as Date | null;
    await moveLead(id, await stageId("Won"));
    assert.ok((await closedAt()) instanceof Date);
    assert.equal((await events()).at(-1)?.payload.toKind, "won");
    await moveLead(id, await stageId("Lost"));
    assert.ok((await closedAt()) instanceof Date);
    assert.equal((await events()).at(-1)?.payload.toKind, "lost");
    await moveLead(id, await stageId("Contacted"));
    assert.equal(await closedAt(), null);
  });

  it("says lead_not_found or stage_not_found and changes nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await lead(await contact());
    await pool!.query("delete from core.events");
    assert.deepEqual(await moveLead(424242, await stageId("Won")), { ok: false, error: "lead_not_found" });
    assert.deepEqual(await moveLead(id, 424242), { ok: false, error: "stage_not_found" });
    assert.equal((await leadHistory(id)).length, 1);
    assert.deepEqual(await events(), []);
  });

  it("keeps the history and the stage consistent when moves arrive at the same time", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await lead(await contact());
    const names = ["Contacted", "Qualified", "Won", "Lost", "Contacted", "New"];
    const targets = await Promise.all(names.map(stageId));
    await Promise.all(targets.map((target) => moveLead(id, target)));
    const history = (await pool!.query("select from_stage_id, to_stage_id from contacts.lead_stage_events where lead_id = $1 order by id", [id])).rows;
    const now = Number((await pool!.query("select stage_id from contacts.leads where id = $1", [id])).rows[0].stage_id);
    assert.equal(Number(history.at(-1).to_stage_id), now, "the last history row is where the lead is");
    for (let index = 1; index < history.length; index += 1) {
      assert.equal(history[index].from_stage_id, history[index - 1].to_stage_id, "each move starts where the previous one ended");
    }
  });
});

describe("loadBoard, leadsOfContact and leadHistory", { concurrency: false }, () => {
  it("groups the leads by stage in the order of the stages, newest first, with the contact's name", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await contact("Ada");
    const grace = await contact("Grace");
    const first = await lead(ada, "First");
    const second = await lead(grace, "Second");
    await moveLead(second, await stageId("Qualified"));
    const third = await lead(grace, "Third");
    const board = await loadBoard();
    assert.deepEqual(board.map((column) => column.name), ["New", "Contacted", "Qualified", "Won", "Lost"]);
    assert.deepEqual(board[0]!.leads.map((l) => [l.id, l.title, l.contactName]), [[third, "Third", "Grace"], [first, "First", "Ada"]]);
    assert.deepEqual(board[2]!.leads.map((l) => l.id), [second]);
    assert.deepEqual(board[3]!.leads, []);
  });

  it("lists the leads of one contact with the name of the stage each is in", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await contact("Ada");
    const other = await contact("Other");
    const id = await lead(ada, "Mine");
    await lead(other, "Not mine");
    await moveLead(id, await stageId("Won"));
    const rows = await leadsOfContact(ada);
    assert.deepEqual(rows.map((l) => [l.title, l.stage]), [["Mine", "Won"]]);
  });
});
