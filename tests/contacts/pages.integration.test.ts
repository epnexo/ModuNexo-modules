import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { validateManifest } from "@modunexo/sdk";
import ContactsPage from "../../contacts/web/contacts-page.tsx";
import PipelinePage from "../../contacts/web/pipeline-page.tsx";
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
  await pool!.query("delete from contacts.contacts");
});

const search = (params: { q?: string; c?: string } = {}) => Promise.resolve(params);
const html = async (page: Promise<unknown>) => renderToStaticMarkup((await page) as never);
const contact = async (name: string, over: Record<string, string> = {}) =>
  Number((await pool!.query("insert into contacts.contacts (name, phone, email, notes) values ($1, $2, $3, $4) returning id", [name, over.phone ?? null, over.email ?? null, over.notes ?? null])).rows[0].id);
const stageId = async (name: string) => Number((await pool!.query("select id from contacts.pipeline_stages where name = $1", [name])).rows[0].id);

describe("the contacts manifest declares the pages", () => {
  it("opens /contacts and /pipeline for readers and the five form routes for writers, none of them public", () => {
    const checked = validateManifest(contacts);
    const byPath = new Map(checked.pages?.map((page) => [page.path, page]));
    for (const path of ["/contacts", "/pipeline"]) {
      assert.equal(byPath.get(path)?.kind, "page", path);
      assert.equal(byPath.get(path)?.permission, "contacts.read", path);
    }
    for (const path of ["/contacts/save", "/contacts/delete", "/pipeline/lead", "/pipeline/move", "/pipeline/stage"]) {
      assert.equal(byPath.get(path)?.kind, "route", path);
      assert.deepEqual(byPath.get(path)?.methods, ["POST"], path);
      assert.equal(byPath.get(path)?.permission, "contacts.write", path);
    }
    assert.equal(checked.pages?.some((page) => page.public !== undefined), false);
    assert.deepEqual(checked.nav?.map((entry) => [entry.label, entry.href, entry.permission]), [["Contacts", "/contacts", "contacts.read"], ["Pipeline", "/pipeline", "contacts.read"]]);
  });
});

describe("/contacts", { concurrency: false }, () => {
  it("says there is no contact yet and still offers the form to add one", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await html(ContactsPage({ searchParams: search() }));
    assert.match(out, /No contact yet/);
    assert.match(out, /action="\/contacts\/save"/);
  });

  it("lists the contacts newest first, each linking to its detail", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const first = await contact("Ada Lovelace", { email: "ada@example.com" });
    const second = await contact("Grace Hopper", { phone: "999" });
    const out = await html(ContactsPage({ searchParams: search() }));
    assert.ok(out.indexOf("Grace Hopper") < out.indexOf("Ada Lovelace"), "newest first");
    assert.match(out, new RegExp(`href="/contacts\\?c=${first}"`));
    assert.match(out, new RegExp(`href="/contacts\\?c=${second}"`));
  });

  it("filters by the search and keeps the search in the box", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await contact("Ada Lovelace");
    await contact("Grace Hopper");
    const out = await html(ContactsPage({ searchParams: search({ q: "grace" }) }));
    assert.match(out, /Grace Hopper/);
    assert.doesNotMatch(out, /Ada Lovelace/);
    assert.match(out, /name="q"[^>]*value="grace"|value="grace"[^>]*name="q"/);
  });

  it("shows the selected contact with its edit form, its delete form and its leads", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact("Ada Lovelace", { notes: "Met at the fair" });
    await pool!.query("insert into contacts.leads (contact_id, stage_id, title, amount) values ($1, $2, 'Website', 1500)", [id, await stageId("Qualified")]);
    const out = await html(ContactsPage({ searchParams: search({ c: String(id) }) }));
    assert.match(out, /Met at the fair/);
    assert.match(out, new RegExp(`<input type="hidden" name="id" value="${id}"`));
    assert.match(out, /action="\/contacts\/delete"/);
    assert.match(out, /Website/);
    assert.match(out, /Qualified/);
    assert.match(out, /action="\/pipeline\/lead"/);
  });

  it("says a contact does not exist when the id has none, and ignores an id that is not a number", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.match(await html(ContactsPage({ searchParams: search({ c: "424242" }) })), /That contact does not exist/);
    const odd = await html(ContactsPage({ searchParams: search({ c: "abc" }) }));
    assert.match(odd, /Select a contact/);
  });

  it("escapes what a contact holds, so a name cannot add markup to the page", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact('<script>alert("x")</script>', { notes: "<img src=x onerror=alert(1)>" });
    const out = await html(ContactsPage({ searchParams: search({ c: String(id) }) }));
    assert.doesNotMatch(out, /<script>alert/);
    assert.doesNotMatch(out, /<img src=x/);
    assert.match(out, /&lt;script&gt;/);
  });
});

describe("/pipeline", { concurrency: false }, () => {
  it("shows a column per stage in order, even with no lead, and the forms to add a lead and a stage", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const out = await html(PipelinePage());
    const at = ["New", "Contacted", "Qualified", "Won", "Lost"].map((name) => out.indexOf(`>${name}<`));
    assert.ok(at.every((index) => index >= 0), String(at));
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in the order of the stages");
    assert.match(out, /action="\/pipeline\/stage"/);
    assert.match(out, /Add a contact first/, "a lead needs a contact");
  });

  it("shows each lead in its stage with its contact, amount and priority, and a form to move it", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact("Ada Lovelace");
    const lead = Number((await pool!.query("insert into contacts.leads (contact_id, stage_id, title, amount, priority) values ($1, $2, 'Website', 1500.5, 'high') returning id", [id, await stageId("Contacted")])).rows[0].id);
    const out = await html(PipelinePage());
    assert.match(out, /Website/);
    assert.match(out, /Ada Lovelace/);
    assert.match(out, /1,500\.50|1500\.50|1,500\.5/);
    assert.match(out, /high/i);
    assert.match(out, /action="\/pipeline\/move"/);
    assert.match(out, new RegExp(`<input type="hidden" name="leadId" value="${lead}"`));
    assert.match(out, /<option[^>]*value="\d+"[^>]*>Won<\/option>/);
  });

  it("offers the contacts in the new-lead form once there is one", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact("Ada Lovelace");
    const out = await html(PipelinePage());
    assert.match(out, new RegExp(`<option value="${id}">Ada Lovelace</option>`));
    assert.doesNotMatch(out, /Add a contact first/);
  });

  it("escapes a lead title and a stage name", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await contact("Ada");
    await pool!.query("insert into contacts.leads (contact_id, stage_id, title) values ($1, $2, $3)", [id, await stageId("New"), "<b>bold</b>"]);
    const out = await html(PipelinePage());
    assert.doesNotMatch(out, /<b>bold<\/b>/);
    assert.match(out, /&lt;b&gt;bold&lt;\/b&gt;/);
  });
});
