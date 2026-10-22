import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import { createContact, contactInput, deleteContact, getContact, listContacts, updateContact } from "../../contacts/lib/contacts.ts";
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

const events = async () => (await pool!.query("select type, payload from core.events order by id")).rows as { type: string; payload: Record<string, unknown> }[];
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const input = (over: Record<string, unknown> = {}) => {
  const checked = contactInput({ name: "Ada Lovelace", ...over });
  assert.ok(checked.ok, JSON.stringify(checked));
  return checked.value;
};

describe("the contacts manifest", () => {
  it("is valid, owns its schema and declares the three events with the read permission", () => {
    const checked = validateManifest(contacts);
    assert.equal(checked.schema, "contacts");
    assert.deepEqual(checked.events?.map((e) => [e.name, e.permission]), [
      ["contact.created", "contacts.read"],
      ["contact.deleted", "contacts.read"],
      ["lead.stage_changed", "contacts.read"],
    ]);
  });
});

describe("contactInput", () => {
  it("trims the fields and turns a blank optional field into null", () => {
    const checked = contactInput({ name: "  Ada  ", phone: " ", email: "", identity: undefined, notes: null });
    assert.deepEqual(checked, { ok: true, value: { name: "Ada", phone: null, email: null, identity: null, notes: null } });
  });

  it("requires a name of 1 to 200 characters", () => {
    for (const name of [undefined, "", "   ", "x".repeat(201), 7]) {
      const checked = contactInput({ name });
      assert.equal(checked.ok, false, String(name));
      if (!checked.ok) assert.match(checked.error, /"name"/);
    }
    assert.equal(contactInput({ name: "x".repeat(200) }).ok, true);
  });

  it("refuses an email without an @, a phone over 40 characters, an identity over 200, notes over 4000 and a NUL character", () => {
    const bad: [string, unknown][] = [["email", "ada.example.com"], ["phone", "1".repeat(41)], ["identity", "i".repeat(201)], ["notes", "n".repeat(4001)], ["name", "Ada\u0000"], ["notes", "a\u0000b"]];
    for (const [field, value] of bad) {
      const checked = contactInput({ name: "Ada", [field]: value });
      assert.equal(checked.ok, false, field);
      if (!checked.ok) assert.match(checked.error, new RegExp(`"${field}"`));
    }
  });
});

describe("createContact", { concurrency: false }, () => {
  it("stores the contact and announces contact.created once, in the same write", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const made = await createContact(input({ phone: "+57 300 111 2233", email: "ada@example.com", identity: "wa:+573001112233", notes: "Met at the fair" }));
    assert.equal(made.ok, true);
    const id = made.ok ? made.id : -1;
    const row = (await pool!.query("select name, phone, email, identity, notes from contacts.contacts where id = $1", [id])).rows[0];
    assert.deepEqual(row, { name: "Ada Lovelace", phone: "+57 300 111 2233", email: "ada@example.com", identity: "wa:+573001112233", notes: "Met at the fair" });
    assert.deepEqual(await events(), [{ type: "contacts.contact.created", payload: { contactId: id } }]);
  });

  it("refuses a second contact with the same identity and announces nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await createContact(input({ identity: "wa:1" }));
    await pool!.query("delete from core.events");
    const again = await createContact(input({ name: "Other", identity: "wa:1" }));
    assert.deepEqual(again, { ok: false, error: "identity_taken" });
    assert.equal(await count("contacts.contacts"), 1);
    assert.deepEqual(await events(), []);
  });

  it("allows many contacts without an identity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal((await createContact(input({ name: "A" }))).ok, true);
    assert.equal((await createContact(input({ name: "B" }))).ok, true);
    assert.equal(await count("contacts.contacts"), 2);
  });
});

describe("updateContact", { concurrency: false }, () => {
  it("changes the fields and the update time, and announces nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const made = await createContact(input());
    const id = made.ok ? made.id : -1;
    await pool!.query("delete from core.events");
    const before = (await pool!.query("select updated_at from contacts.contacts where id = $1", [id])).rows[0].updated_at as Date;
    assert.deepEqual(await updateContact(id, input({ name: "Ada B.", phone: "123" })), { ok: true });
    const row = (await pool!.query("select name, phone, updated_at from contacts.contacts where id = $1", [id])).rows[0];
    assert.equal(row.name, "Ada B.");
    assert.equal(row.phone, "123");
    assert.ok(row.updated_at > before);
    assert.deepEqual(await events(), []);
  });

  it("says not_found for a contact that does not exist, and identity_taken for another contact's identity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.deepEqual(await updateContact(424242, input()), { ok: false, error: "not_found" });
    await createContact(input({ name: "First", identity: "wa:1" }));
    const second = await createContact(input({ name: "Second", identity: "wa:2" }));
    assert.deepEqual(await updateContact(second.ok ? second.id : -1, input({ name: "Second", identity: "wa:1" })), { ok: false, error: "identity_taken" });
  });

  it("lets a contact keep its own identity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const made = await createContact(input({ identity: "wa:1" }));
    assert.deepEqual(await updateContact(made.ok ? made.id : -1, input({ identity: "wa:1", notes: "same" })), { ok: true });
  });
});

describe("deleteContact", { concurrency: false }, () => {
  it("removes the contact with its leads and their history, and announces contact.deleted once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const made = await createContact(input());
    const id = made.ok ? made.id : -1;
    const stage = Number((await pool!.query("select id from contacts.pipeline_stages order by position limit 1")).rows[0].id);
    const lead = await pool!.query("insert into contacts.leads (contact_id, stage_id, title) values ($1, $2, 'Deal') returning id", [id, stage]);
    await pool!.query("insert into contacts.lead_stage_events (lead_id, to_stage_id) values ($1, $2)", [lead.rows[0].id, stage]);
    await pool!.query("delete from core.events");
    assert.equal(await deleteContact(id), true);
    assert.equal(await count("contacts.contacts"), 0);
    assert.equal(await count("contacts.leads"), 0);
    assert.equal(await count("contacts.lead_stage_events"), 0);
    assert.deepEqual(await events(), [{ type: "contacts.contact.deleted", payload: { contactId: id } }]);
  });

  it("returns false and announces nothing for a contact that does not exist", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal(await deleteContact(424242), false);
    assert.deepEqual(await events(), []);
  });
});

describe("listContacts and getContact", { concurrency: false }, () => {
  it("lists the newest first and returns at most 100", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await pool!.query("insert into contacts.contacts (name) select 'c' || n from generate_series(1, 103) n");
    const rows = await listContacts();
    assert.equal(rows.length, 100);
    assert.equal(rows[0]!.name, "c103");
  });

  it("searches name, phone, email and identity without caring about case, and treats % and _ as plain characters", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await createContact(input({ name: "Ada Lovelace", phone: "300-111", email: "ada@math.org", identity: "wa:+57300" }));
    await createContact(input({ name: "Grace Hopper", phone: "999", email: "grace@navy.mil" }));
    await createContact(input({ name: "100% real_name" }));
    const names = async (q: string) => (await listContacts(q)).map((row) => row.name);
    assert.deepEqual(await names("LOVE"), ["Ada Lovelace"]);
    assert.deepEqual(await names("300-1"), ["Ada Lovelace"]);
    assert.deepEqual(await names("navy.MIL"), ["Grace Hopper"]);
    assert.deepEqual(await names("wa:+573"), ["Ada Lovelace"]);
    assert.deepEqual(await names("100%"), ["100% real_name"]);
    assert.deepEqual(await names("rea_"), [], "an underscore is not a wildcard");
    assert.deepEqual(await names("real_n"), ["100% real_name"]);
    assert.equal((await listContacts("  ")).length, 3, "a blank search lists everything");
  });

  it("gets one contact, or null when there is none", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const made = await createContact(input({ name: "Ada", email: "ada@example.com" }));
    const row = await getContact(made.ok ? made.id : -1);
    assert.equal(row?.name, "Ada");
    assert.equal(row?.email, "ada@example.com");
    assert.equal(await getContact(424242), null);
  });
});
