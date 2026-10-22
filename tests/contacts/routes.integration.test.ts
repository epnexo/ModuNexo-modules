import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { POST as deleteContactRoute } from "../../contacts/web/contact-delete.ts";
import { POST as saveContactRoute } from "../../contacts/web/contact-save.ts";
import { POST as createLeadRoute } from "../../contacts/web/lead-create.ts";
import { POST as moveLeadRoute } from "../../contacts/web/lead-move.ts";
import { POST as saveStageRoute } from "../../contacts/web/stage-save.ts";
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

beforeEach(async () => {
  if (skipReason) return;
  await pool!.query("delete from core.events");
  await pool!.query("delete from contacts.contacts");
});

const SAME = { origin: "http://shell.test", host: "shell.test" };
const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = SAME) =>
  new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const location = (response: Response) => response.headers.get("location");
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;
const stageId = async (name: string) => Number((await pool!.query("select id from contacts.pipeline_stages where name = $1", [name])).rows[0].id);
const newContact = async (name = "Ada") => Number((await pool!.query("insert into contacts.contacts (name) values ($1) returning id", [name])).rows[0].id);
const newLead = async (contactId: number) => Number((await pool!.query("insert into contacts.leads (contact_id, stage_id, title) values ($1, (select id from contacts.pipeline_stages order by position limit 1), 'Deal') returning id", [contactId])).rows[0].id);

type Route = [string, (request: Request) => Promise<Response>, string, Record<string, string>];
const ROUTES: Route[] = [
  ["/contacts/save", saveContactRoute, "contacts.contacts", { name: "Ada" }],
  ["/contacts/delete", deleteContactRoute, "contacts.contacts", { id: "1" }],
  ["/pipeline/lead", createLeadRoute, "contacts.leads", { contactId: "1", title: "Deal" }],
  ["/pipeline/move", moveLeadRoute, "contacts.lead_stage_events", { leadId: "1", stageId: "1" }],
  ["/pipeline/stage", saveStageRoute, "contacts.pipeline_stages", { name: "Proposal" }],
];

describe("every form route", { concurrency: false }, () => {
  for (const [path, handler, table, fields] of ROUTES) {
    it(`${path} refuses another site and a request with no origin, and a body that is not a form, and writes nothing`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      await newContact();
      const before = await count(table);
      assert.equal((await handler(form(path, fields, { origin: "http://evil.test", host: "shell.test" }))).status, 403);
      assert.equal((await handler(form(path, fields, { host: "shell.test" }))).status, 403);
      const json = new Request(`http://shell.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...SAME }, body: JSON.stringify(fields) });
      assert.equal((await handler(json)).status, 400);
      assert.equal(await count(table), before);
      assert.equal(await count("core.events"), 0);
    });
  }
});

describe("POST /contacts/save", { concurrency: false }, () => {
  it("creates a contact, announces it and sends the browser to that contact", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await saveContactRoute(form("/contacts/save", { name: " Ada ", phone: "300", email: "ada@example.com", identity: "wa:1", notes: "hi" }));
    assert.equal(response.status, 303);
    const row = (await pool!.query("select id, name, phone, email, identity, notes from contacts.contacts")).rows[0];
    assert.equal(location(response), `/contacts?c=${row.id}`);
    assert.deepEqual([row.name, row.phone, row.email, row.identity, row.notes], ["Ada", "300", "ada@example.com", "wa:1", "hi"]);
    assert.equal(await count("core.events"), 1);
  });

  it("changes the contact named by id", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await newContact("Old");
    const response = await saveContactRoute(form("/contacts/save", { id: String(id), name: "New", phone: "9" }));
    assert.equal(response.status, 303);
    assert.equal(location(response), `/contacts?c=${id}`);
    const row = (await pool!.query("select name, phone from contacts.contacts where id = $1", [id])).rows[0];
    assert.deepEqual([row.name, row.phone], ["New", "9"]);
  });

  it("answers 400 naming the field it cannot use, 404 for an unknown id and 409 for an identity already taken", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const bad = await saveContactRoute(form("/contacts/save", { name: "  " }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"name"/);
    assert.equal((await saveContactRoute(form("/contacts/save", { id: "abc", name: "A" }))).status, 400);
    assert.equal((await saveContactRoute(form("/contacts/save", { id: "424242", name: "A" }))).status, 404);
    await saveContactRoute(form("/contacts/save", { name: "First", identity: "wa:1" }));
    const clash = await saveContactRoute(form("/contacts/save", { name: "Second", identity: "wa:1" }));
    assert.equal(clash.status, 409);
    assert.match(await errorOf(clash), /identity/);
    assert.equal(await count("contacts.contacts"), 1);
  });
});

describe("POST /contacts/delete", { concurrency: false }, () => {
  it("deletes the contact and sends the browser to the list", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await newContact();
    const response = await deleteContactRoute(form("/contacts/delete", { id: String(id) }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/contacts");
    assert.equal(await count("contacts.contacts"), 0);
  });

  it("answers 400 for an id that is not a number and 404 for a contact that does not exist", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await deleteContactRoute(form("/contacts/delete", { id: "x" }))).status, 400);
    assert.equal((await deleteContactRoute(form("/contacts/delete", { id: "424242" }))).status, 404);
  });
});

describe("POST /pipeline/lead", { concurrency: false }, () => {
  it("creates a lead in the first stage and sends the browser to the pipeline", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const contactId = await newContact();
    const response = await createLeadRoute(form("/pipeline/lead", { contactId: String(contactId), title: "Website", amount: "1500.5", priority: "high" }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/pipeline");
    const row = (await pool!.query("select l.title, l.amount, l.priority, s.name as stage from contacts.leads l join contacts.pipeline_stages s on s.id = l.stage_id")).rows[0];
    assert.deepEqual([row.title, Number(row.amount), row.priority, row.stage], ["Website", 1500.5, "high", "New"]);
  });

  it("answers 400 for a value it cannot use and 404 for an unknown contact", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const contactId = await newContact();
    const bad = await createLeadRoute(form("/pipeline/lead", { contactId: String(contactId), title: "A", amount: "-1" }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"amount"/);
    assert.equal((await createLeadRoute(form("/pipeline/lead", { contactId: "424242", title: "A" }))).status, 404);
    assert.equal(await count("contacts.leads"), 0);
  });
});

describe("POST /pipeline/move", { concurrency: false }, () => {
  it("moves the lead, announces it and sends the browser to the pipeline", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await newLead(await newContact());
    const to = await stageId("Qualified");
    const response = await moveLeadRoute(form("/pipeline/move", { leadId: String(id), stageId: String(to) }));
    assert.equal(response.status, 303);
    assert.equal(location(response), "/pipeline");
    assert.equal(Number((await pool!.query("select stage_id from contacts.leads where id = $1", [id])).rows[0].stage_id), to);
    assert.equal((await pool!.query("select type from core.events")).rows[0].type, "contacts.lead.stage_changed");
  });

  it("answers 400 for ids that are not numbers and 404 for an unknown lead or stage", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await newLead(await newContact());
    assert.equal((await moveLeadRoute(form("/pipeline/move", { leadId: "x", stageId: "1" }))).status, 400);
    assert.equal((await moveLeadRoute(form("/pipeline/move", { leadId: String(id), stageId: "" }))).status, 400);
    assert.equal((await moveLeadRoute(form("/pipeline/move", { leadId: "424242", stageId: String(await stageId("Won")) }))).status, 404);
    assert.equal((await moveLeadRoute(form("/pipeline/move", { leadId: String(id), stageId: "424242" }))).status, 404);
  });
});

describe("POST /pipeline/stage", { concurrency: false }, () => {
  it("adds a stage when there is no id and renames the stage named by id", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const added = await saveStageRoute(form("/pipeline/stage", { name: "Proposal" }));
    assert.equal(added.status, 303);
    assert.equal(location(added), "/pipeline");
    const proposal = await stageId("Proposal");
    const renamed = await saveStageRoute(form("/pipeline/stage", { id: String(proposal), name: "Offer sent" }));
    assert.equal(renamed.status, 303);
    assert.equal((await pool!.query("select name from contacts.pipeline_stages where id = $1", [proposal])).rows[0].name, "Offer sent");
    await pool!.query("delete from contacts.pipeline_stages where id = $1", [proposal]);
  });

  it("answers 400 for a name it cannot use and 404 for an unknown stage", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const bad = await saveStageRoute(form("/pipeline/stage", { name: " " }));
    assert.equal(bad.status, 400);
    assert.match(await errorOf(bad), /"name"/);
    assert.equal((await saveStageRoute(form("/pipeline/stage", { id: "x", name: "A" }))).status, 400);
    assert.equal((await saveStageRoute(form("/pipeline/stage", { id: "424242", name: "A" }))).status, 404);
  });
});
