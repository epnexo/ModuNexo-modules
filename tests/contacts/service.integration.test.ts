import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import { GET as contactRoute } from "../../contacts/web/svc-contact.ts";
import { POST as createContactRoute } from "../../contacts/web/svc-contact-create.ts";
import { GET as contactsRoute } from "../../contacts/web/svc-contacts.ts";
import { POST as updateContactRoute } from "../../contacts/web/svc-contact-update.ts";
import { POST as createLeadRoute } from "../../contacts/web/svc-lead-create.ts";
import { POST as moveLeadRoute } from "../../contacts/web/svc-lead-move.ts";
import { GET as leadsRoute } from "../../contacts/web/svc-leads.ts";
import { GET as stagesRoute } from "../../contacts/web/svc-stages.ts";
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

const BASE = "http://shell.test/svc/contacts";
const get = (path: string) => new Request(`${BASE}${path}`);
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const body = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T;
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const events = async () => (await pool!.query("select type, payload from core.events order by id")).rows as { type: string; payload: Record<string, unknown> }[];
const person = async (name: string, over: Record<string, string | null> = {}) =>
  Number((await pool!.query("insert into contacts.contacts (name, phone, email, identity, notes) values ($1, $2, $3, $4, $5) returning id", [name, over.phone ?? null, over.email ?? null, over.identity ?? null, over.notes ?? null])).rows[0].id);
const stageId = async (name: string) => Number((await pool!.query("select id from contacts.pipeline_stages where name = $1", [name])).rows[0].id);
const lead = async (contactId: number, title = "Deal") => Number((await pool!.query("insert into contacts.leads (contact_id, stage_id, title) values ($1, (select id from contacts.pipeline_stages order by position limit 1), $2) returning id", [contactId, title])).rows[0].id);

describe("the contacts manifest declares the service API", () => {
  it("is version 0.2.0 and offers each route under the scope it needs, none of them public", () => {
    const checked = validateManifest(contacts);
    assert.equal(checked.version, "0.2.0");
    assert.deepEqual(checked.scopes?.map((s) => s.key), ["contacts.read", "contacts.write", "leads.read", "leads.write"]);
    const byPath = new Map(checked.pages?.map((page) => [page.path, page]));
    const routes: [string, string, string][] = [
      ["/svc/contacts/contact", "GET", "contacts.read"],
      ["/svc/contacts/contacts", "GET", "contacts.read"],
      ["/svc/contacts/contacts/create", "POST", "contacts.write"],
      ["/svc/contacts/contacts/update", "POST", "contacts.write"],
      ["/svc/contacts/stages", "GET", "leads.read"],
      ["/svc/contacts/leads", "GET", "leads.read"],
      ["/svc/contacts/leads/create", "POST", "leads.write"],
      ["/svc/contacts/leads/move", "POST", "leads.write"],
    ];
    for (const [path, method, scope] of routes) {
      assert.deepEqual(byPath.get(path)?.methods, [method], path);
      assert.equal(byPath.get(path)?.scope, scope, path);
    }
    assert.equal(checked.pages?.some((page) => page.public !== undefined), false);
  });
});

describe("GET /svc/contacts/contact", { concurrency: false }, () => {
  it("answers the contact found by id, with all its fields", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await person("Ada Lovelace", { phone: "300", email: "ada@example.com", identity: "wa:1", notes: "hi" });
    const response = await contactRoute(get(`/contact?id=${id}`));
    assert.equal(response.status, 200);
    const out = await body(response);
    assert.deepEqual({ ...out, createdAt: typeof out.createdAt, updatedAt: typeof out.updatedAt }, { id, name: "Ada Lovelace", phone: "300", email: "ada@example.com", identity: "wa:1", notes: "hi", createdAt: "string", updatedAt: "string" });
    assert.equal(Number.isNaN(Date.parse(out.createdAt as string)), false);
  });

  it("finds it by channel identity too", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await person("Ada", { identity: "wa:+573001112233" });
    const out = await body(await contactRoute(get(`/contact?identity=${encodeURIComponent("wa:+573001112233")}`)));
    assert.equal(out.id, id);
  });

  it("answers 404 for an unknown contact and 400 unless exactly one of id and identity is given", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await contactRoute(get("/contact?id=424242"))).status, 404);
    assert.equal((await contactRoute(get("/contact?identity=nobody"))).status, 404);
    for (const query of ["", "?id=abc", "?id=0", "?id=1&identity=wa:1", "?identity="]) assert.equal((await contactRoute(get(`/contact${query}`))).status, 400, query);
  });
});

describe("GET /svc/contacts/contacts", { concurrency: false }, () => {
  it("lists the newest first and filters by q", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await person("Ada Lovelace", { email: "ada@math.org" });
    await person("Grace Hopper", { phone: "999" });
    const all = await body<{ contacts: { name: string }[] }>(await contactsRoute(get("/contacts")));
    assert.deepEqual(all.contacts.map((c) => c.name), ["Grace Hopper", "Ada Lovelace"]);
    const found = await body<{ contacts: { name: string }[] }>(await contactsRoute(get("/contacts?q=MATH.org")));
    assert.deepEqual(found.contacts.map((c) => c.name), ["Ada Lovelace"]);
  });

  it("cuts the list at limit, 50 by default, and refuses a limit outside 1 to 100", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pool!.query("insert into contacts.contacts (name) select 'c' || n from generate_series(1, 60) n");
    assert.equal((await body<{ contacts: unknown[] }>(await contactsRoute(get("/contacts")))).contacts.length, 50);
    assert.equal((await body<{ contacts: unknown[] }>(await contactsRoute(get("/contacts?limit=3")))).contacts.length, 3);
    assert.equal((await body<{ contacts: unknown[] }>(await contactsRoute(get("/contacts?limit=100")))).contacts.length, 60);
    for (const limit of ["0", "101", "abc", "-1", "1.5"]) assert.equal((await contactsRoute(get(`/contacts?limit=${limit}`))).status, 400, limit);
  });
});

describe("POST /svc/contacts/contacts/create", { concurrency: false }, () => {
  it("creates the contact, answers 201 with it and announces contact.created", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await createContactRoute(post("/contacts/create", { name: "  Ada  ", identity: "wa:1", email: "ada@example.com" }));
    assert.equal(response.status, 201);
    const out = await body(response);
    assert.deepEqual([out.name, out.identity, out.email, out.phone], ["Ada", "wa:1", "ada@example.com", null]);
    assert.deepEqual(await events(), [{ type: "contacts.contact.created", payload: { contactId: out.id } }]);
  });

  it("answers 409 with the id of the contact that already holds the identity, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await person("First", { identity: "wa:1" });
    const response = await createContactRoute(post("/contacts/create", { name: "Second", identity: "wa:1" }));
    assert.equal(response.status, 409);
    assert.deepEqual(await body(response), { error: "identity_taken", id });
    assert.equal(await count("contacts.contacts"), 1);
    assert.deepEqual(await events(), []);
  });

  it("answers 400 for a body or a field it cannot use, and 413 over 16 KiB", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const bad of ["not json", "[]", "null", {}, { name: "" }, { name: "A", email: "nope" }, { name: "A", phone: "1".repeat(41) }]) {
      assert.equal((await createContactRoute(post("/contacts/create", bad))).status, 400, JSON.stringify(bad));
    }
    const named = await createContactRoute(post("/contacts/create", { name: "A", email: "nope" }));
    assert.match((await body<{ error: string }>(named)).error, /"email"/);
    assert.equal((await createContactRoute(post("/contacts/create", { name: "A", notes: "n".repeat(20_000) }))).status, 413);
    assert.equal(await count("contacts.contacts"), 0);
  });
});

describe("POST /svc/contacts/contacts/update", { concurrency: false }, () => {
  it("changes only the fields it is given and keeps the rest", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await person("Ada", { phone: "300", email: "ada@example.com", notes: "keep" });
    const response = await updateContactRoute(post("/contacts/update", { id, name: "Ada L." }));
    assert.equal(response.status, 200);
    const out = await body(response);
    assert.deepEqual([out.name, out.phone, out.email, out.notes], ["Ada L.", "300", "ada@example.com", "keep"]);
  });

  it("clears an optional field given as null or empty", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await person("Ada", { phone: "300", notes: "x" });
    const out = await body(await updateContactRoute(post("/contacts/update", { id, phone: null, notes: "" })));
    assert.deepEqual([out.phone, out.notes], [null, null]);
  });

  it("answers 404, 409 and 400 where it should, and changes nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const first = await person("First", { identity: "wa:1" });
    const second = await person("Second", { identity: "wa:2", email: "s@example.com" });
    assert.equal((await updateContactRoute(post("/contacts/update", { id: 424242, name: "x" }))).status, 404);
    const clash = await updateContactRoute(post("/contacts/update", { id: second, identity: "wa:1" }));
    assert.equal(clash.status, 409);
    assert.deepEqual(await body(clash), { error: "identity_taken", id: first });
    assert.equal((await updateContactRoute(post("/contacts/update", { id: "x", name: "y" }))).status, 400);
    const bad = await updateContactRoute(post("/contacts/update", { id: second, email: "nope" }));
    assert.equal(bad.status, 400);
    assert.match((await body<{ error: string }>(bad)).error, /"email"/);
    assert.equal((await pool!.query("select email, identity from contacts.contacts where id = $1", [second])).rows[0].email, "s@example.com");
    assert.equal((await pool!.query("select identity from contacts.contacts where id = $1", [second])).rows[0].identity, "wa:2");
  });
});

describe("GET /svc/contacts/stages and /leads", { concurrency: false }, () => {
  it("lists the stages in order with their kind", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await body<{ stages: { name: string; position: number; kind: string }[] }>(await stagesRoute(get("/stages")));
    assert.deepEqual(out.stages.map((s) => [s.name, s.position, s.kind]), [["New", 1, "open"], ["Contacted", 2, "open"], ["Qualified", 3, "open"], ["Won", 4, "won"], ["Lost", 5, "lost"]]);
  });

  it("lists the leads of a contact with the name of their stage, and answers 404 for an unknown contact and 400 without a number", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await person("Ada");
    const other = await person("Other");
    const mine = await lead(ada, "Mine");
    await lead(other, "Not mine");
    await pool!.query("update contacts.leads set stage_id = $2, amount = 120.5, priority = 'high' where id = $1", [mine, await stageId("Qualified")]);
    const out = await body<{ leads: { id: number; title: string; amount: number | null; priority: string; stage: string; closedAt: string | null }[] }>(await leadsRoute(get(`/leads?contactId=${ada}`)));
    assert.deepEqual(out.leads, [{ id: mine, title: "Mine", amount: 120.5, priority: "high", stage: "Qualified", closedAt: null }]);
    assert.equal((await leadsRoute(get("/leads?contactId=424242"))).status, 404);
    for (const query of ["", "?contactId=x", "?contactId=0"]) assert.equal((await leadsRoute(get(`/leads${query}`))).status, 400, query);
  });
});

describe("POST /svc/contacts/leads/create and /leads/move", { concurrency: false }, () => {
  it("creates a lead in the first stage and answers 201", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await person("Ada");
    const response = await createLeadRoute(post("/leads/create", { contactId: ada, title: "Website", amount: 1500.5, priority: "high" }));
    assert.equal(response.status, 201);
    const { id } = await body<{ id: number }>(response);
    const row = (await pool!.query("select l.title, l.amount, l.priority, s.name as stage from contacts.leads l join contacts.pipeline_stages s on s.id = l.stage_id where l.id = $1", [id])).rows[0];
    assert.deepEqual([row.title, Number(row.amount), row.priority, row.stage], ["Website", 1500.5, "high", "New"]);
    assert.deepEqual(await events(), [], "a new lead announces nothing");
  });

  it("answers 404 contact_not_found and 400 naming the field", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await person("Ada");
    const missing = await createLeadRoute(post("/leads/create", { contactId: 424242, title: "x" }));
    assert.equal(missing.status, 404);
    assert.equal((await body<{ error: string }>(missing)).error, "contact_not_found");
    const bad = await createLeadRoute(post("/leads/create", { contactId: ada, title: "x", amount: -1 }));
    assert.equal(bad.status, 400);
    assert.match((await body<{ error: string }>(bad)).error, /"amount"/);
    assert.equal(await count("contacts.leads"), 0);
  });

  it("moves a lead, says whether it changed and announces lead.stage_changed once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const ada = await person("Ada");
    const id = await lead(ada);
    const to = await stageId("Won");
    const moved = await moveLeadRoute(post("/leads/move", { leadId: id, stageId: to }));
    assert.equal(moved.status, 200);
    assert.deepEqual(await body(moved), { ok: true, changed: true });
    assert.deepEqual(await body(await moveLeadRoute(post("/leads/move", { leadId: id, stageId: to }))), { ok: true, changed: false });
    const seen = await events();
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.payload, { leadId: id, contactId: ada, fromStageId: await stageId("New"), toStageId: to, toKind: "won" });
  });

  it("answers 404 for an unknown lead or stage and 400 for ids that are not numbers", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await lead(await person("Ada"));
    const noLead = await moveLeadRoute(post("/leads/move", { leadId: 424242, stageId: await stageId("Won") }));
    assert.equal(noLead.status, 404);
    assert.equal((await body<{ error: string }>(noLead)).error, "lead_not_found");
    const noStage = await moveLeadRoute(post("/leads/move", { leadId: id, stageId: 424242 }));
    assert.equal(noStage.status, 404);
    assert.equal((await body<{ error: string }>(noStage)).error, "stage_not_found");
    assert.equal((await moveLeadRoute(post("/leads/move", { leadId: "x", stageId: 1 }))).status, 400);
    assert.equal((await moveLeadRoute(post("/leads/move", { leadId: id }))).status, 400);
  });
});
