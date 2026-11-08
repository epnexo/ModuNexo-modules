import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { addMissingProfileKeys, getProfile, saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, createTemplate, getTemplate, getTemplateBySlug, listTemplates, updateTemplate } from "../src/template-store.ts";
import type { TemplateInput } from "../src/template-rules.ts";
import { PROFILE_FIELDS } from "../src/profile.ts";
import { loadProfileValues, loadTemplateEditData, loadTemplatesData } from "../web/loaders.ts";
import { submitArchive, submitNewTemplate, submitProfile, submitTemplateUpdate } from "../web/submit.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_store"));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
  await pool.query("delete from documents.settings");
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const input = (extra: Partial<TemplateInput> = {}): TemplateInput => ({
  name: "Mutual NDA",
  slug: "nda",
  kind: "nda",
  refPrefix: "NDA",
  bodyHtml: "<p>{{B_NOMBRE}}</p>",
  counterpartyMarker: null,
  ...extra,
});

describe("template store", () => {
  test("creates a template and reads it back by id and by slug", async () => {
    const created = await createTemplate(pool!, input());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const byId = await getTemplate(pool!, created.id);
    assert.ok(byId);
    assert.deepEqual(
      { slug: byId.slug, name: byId.name, kind: byId.kind, refPrefix: byId.refPrefix, bodyHtml: byId.bodyHtml, archivedAt: byId.archivedAt },
      { slug: "nda", name: "Mutual NDA", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{B_NOMBRE}}</p>", archivedAt: null },
    );
    assert.ok(byId.createdAt instanceof Date);
    assert.equal((await getTemplateBySlug(pool!, "nda"))?.id, created.id);
  });

  test("stores the counterparty marker, or none, and updates it", async () => {
    const created = await createTemplate(pool!, input({ counterpartyMarker: "B_NOMBRE" }));
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal((await getTemplate(pool!, created.id))?.counterpartyMarker, "B_NOMBRE");
    assert.equal(await updateTemplate(pool!, created.id, input({ counterpartyMarker: null })), "updated");
    assert.equal((await getTemplate(pool!, created.id))?.counterpartyMarker, null);
    const bare = await createTemplate(pool!, input({ slug: "bare" }));
    assert.equal(bare.ok && (await getTemplate(pool!, bare.id))?.counterpartyMarker, null);
  });

  test("returns null for an unknown id or slug", async () => {
    assert.equal(await getTemplate(pool!, 999999), null);
    assert.equal(await getTemplateBySlug(pool!, "missing"), null);
  });

  test("refuses a duplicate slug and creates nothing", async () => {
    await createTemplate(pool!, input());
    assert.deepEqual(await createTemplate(pool!, input({ name: "Other" })), { ok: false, reason: "slug-taken" });
    assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 1);
  });

  test("stores a body with quotes, backslashes and braces as is (parameterized)", async () => {
    const body = `<p title="x">'; drop table documents.templates; -- \\ {{A}}</p>`;
    const created = await createTemplate(pool!, input({ bodyHtml: body }));
    assert.equal(created.ok && (await getTemplate(pool!, created.id))?.bodyHtml, body);
  });

  test("lists active templates by name and hides archived ones", async () => {
    const b = await createTemplate(pool!, input({ slug: "b", name: "B contract" }));
    await createTemplate(pool!, input({ slug: "a", name: "A proposal", kind: "proposal" }));
    const gone = await createTemplate(pool!, input({ slug: "c", name: "C old" }));
    assert.ok(b.ok && gone.ok);
    if (!gone.ok) return;
    assert.equal(await archiveTemplate(pool!, gone.id), true);
    assert.deepEqual((await listTemplates(pool!)).map((t) => t.slug), ["a", "b"]);
  });

  test("updates every editable field and moves updated_at forward", async () => {
    const created = await createTemplate(pool!, input());
    assert.ok(created.ok);
    if (!created.ok) return;
    const before = (await getTemplate(pool!, created.id))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await updateTemplate(pool!, created.id, input({ name: "Renamed", slug: "renamed", kind: "contract", refPrefix: "CON", bodyHtml: "<p>new</p>" }));
    assert.equal(result, "updated");
    const after = (await getTemplate(pool!, created.id))!;
    assert.deepEqual([after.name, after.slug, after.kind, after.refPrefix, after.bodyHtml], ["Renamed", "renamed", "contract", "CON", "<p>new</p>"]);
    assert.ok(after.updatedAt > before.updatedAt);
    assert.deepEqual(after.createdAt, before.createdAt);
  });

  test("keeps the same slug on update but refuses another template's slug", async () => {
    const a = await createTemplate(pool!, input({ slug: "a" }));
    const b = await createTemplate(pool!, input({ slug: "b" }));
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(await updateTemplate(pool!, a.id, input({ slug: "a", name: "Same slug" })), "updated");
    assert.equal(await updateTemplate(pool!, a.id, input({ slug: "b" })), "slug-taken");
    assert.equal((await getTemplate(pool!, a.id))?.slug, "a");
  });

  test("the database names the slug constraint the way updateTemplate checks it, and no other unique violation is reported as a taken slug", async () => {
    const a = await createTemplate(pool!, input({ slug: "a" }));
    const b = await createTemplate(pool!, input({ slug: "b" }));
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    await assert.rejects(pool!.query("update documents.templates set slug = 'b' where id = $1", [a.id]), { code: "23505", constraint: "templates_slug_key" });
    assert.equal(await updateTemplate(pool!, a.id, input({ slug: "b" })), "slug-taken");
    const unique = await pool!.query("select count(*) as n from pg_constraint where conrelid = 'documents.templates'::regclass and contype = 'u'");
    assert.equal(Number(unique.rows[0].n), 1, "the slug is the only unique constraint besides the key, so a second one would need a second check");
  });

  test("reports not-found when updating a missing or archived template", async () => {
    assert.equal(await updateTemplate(pool!, 999999, input()), "not-found");
    const created = await createTemplate(pool!, input());
    assert.ok(created.ok);
    if (!created.ok) return;
    await archiveTemplate(pool!, created.id);
    assert.equal(await updateTemplate(pool!, created.id, input({ name: "Edited" })), "not-found");
    assert.equal((await getTemplate(pool!, created.id))?.name, "Mutual NDA");
  });

  test("archives once: the row stays with its archive time, a second archive finds nothing", async () => {
    const created = await createTemplate(pool!, input());
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.equal(await archiveTemplate(pool!, created.id), true);
    const archived = (await getTemplate(pool!, created.id))!;
    assert.ok(archived.archivedAt instanceof Date);
    assert.equal(await archiveTemplate(pool!, created.id), false);
    assert.equal(await archiveTemplate(pool!, 999999), false);
    assert.deepEqual(await createTemplate(pool!, input()), { ok: false, reason: "slug-taken" }, "an archived slug stays reserved");
  });
});

describe("profile store", () => {
  test("reads an empty profile when nothing was saved", async () => {
    assert.deepEqual(await getProfile(pool!), {});
  });

  test("saves, then merges: set keys win, removed keys go, other keys stay", async () => {
    await saveProfile(pool!, { set: { A_NOMBRE: "Acme", COLOR: "#112233" }, remove: [] });
    assert.deepEqual(await getProfile(pool!), { A_NOMBRE: "Acme", COLOR: "#112233" });

    await pool!.query("update documents.settings set profile = profile || '{\"CUSTOM\":\"kept\"}'::jsonb");
    await saveProfile(pool!, { set: { A_NOMBRE: "Acme Ltd" }, remove: ["COLOR", "NEVER_SET"] });
    assert.deepEqual(await getProfile(pool!), { A_NOMBRE: "Acme Ltd", CUSTOM: "kept" });
  });

  test("stays a single row however many times it is saved", async () => {
    for (let i = 0; i < 3; i++) await saveProfile(pool!, { set: { A_NOMBRE: `v${i}` }, remove: [] });
    assert.equal(Number((await pool!.query("select count(*) as n from documents.settings")).rows[0].n), 1);
    assert.equal((await pool!.query("select id from documents.settings")).rows[0].id, 1);
  });

  test("stores values as data, never as SQL", async () => {
    const value = `x'); drop table documents.settings; --`;
    await saveProfile(pool!, { set: { A_NOMBRE: value }, remove: [] });
    assert.equal((await getProfile(pool!)).A_NOMBRE, value);
  });

  test("adds only the keys the profile does not have yet and reports them", async () => {
    assert.deepEqual(await addMissingProfileKeys(pool!, { A_NOMBRE: "Acme", COLOR: "#112233" }), ["A_NOMBRE", "COLOR"]);
    assert.deepEqual(await addMissingProfileKeys(pool!, { A_NOMBRE: "Other", COLOR: "#445566", MESES: "12" }), ["MESES"]);
    assert.deepEqual(await getProfile(pool!), { A_NOMBRE: "Acme", COLOR: "#112233", MESES: "12" });
  });

  test("changes nothing, not even updated_at, when every key is already there", async () => {
    await addMissingProfileKeys(pool!, { A_NOMBRE: "Acme" });
    const before = (await pool!.query("select updated_at from documents.settings")).rows[0].updated_at as Date;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await addMissingProfileKeys(pool!, { A_NOMBRE: "Changed" }), []);
    assert.deepEqual((await pool!.query("select updated_at from documents.settings")).rows[0].updated_at, before);
    assert.deepEqual(await addMissingProfileKeys(pool!, {}), []);
  });
});

const form = (extra: Record<string, string> = {}) => ({ name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{B_NOMBRE}}</p>", ...extra });

describe("submitNewTemplate", () => {
  test("creates the template and redirects to its edit page", async () => {
    const outcome = await submitNewTemplate(pool!, form());
    const created = await getTemplateBySlug(pool!, "nda");
    assert.ok(created);
    assert.deepEqual(outcome, { redirectTo: `/documents/templates/${created.id}?saved=1` });
  });

  test("returns field errors and the entered values, and creates nothing, when the input is invalid", async () => {
    const outcome = await submitNewTemplate(pool!, form({ slug: "Bad Slug", refPrefix: "nda", bodyHtml: "<p>kept {{X}}</p>" }));
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.deepEqual(Object.keys(outcome.state.errors).sort(), ["refPrefix", "slug"]);
    assert.equal(outcome.state.values.bodyHtml, "<p>kept {{X}}</p>");
    assert.equal(outcome.state.values.slug, "Bad Slug");
    assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 0);
  });

  test("reports a taken slug on the slug field and keeps the values", async () => {
    await submitNewTemplate(pool!, form());
    const outcome = await submitNewTemplate(pool!, form({ name: "Second" }));
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.errors.slug!, /already used/);
    assert.equal(outcome.state.values.name, "Second");
    assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 1);
  });

});

describe("submitTemplateUpdate", () => {
  const seed = async (slug = "nda") => {
    const created = await createTemplate(pool!, input({ slug }));
    assert.ok(created.ok);
    return created.ok ? created.id : 0;
  };

  test("updates the template and reports it saved with the stored values", async () => {
    const id = await seed();
    const outcome = await submitTemplateUpdate(pool!, { ...form({ name: "Renamed" }), id: String(id) });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.equal(outcome.state.saved, true);
    assert.equal(outcome.state.values.name, "Renamed");
    assert.equal((await getTemplate(pool!, id))?.name, "Renamed");
  });

  test("returns field errors without touching the row", async () => {
    const id = await seed();
    const outcome = await submitTemplateUpdate(pool!, { ...form({ name: "" }), id: String(id) });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.ok(outcome.state.errors.name);
    assert.equal(outcome.state.saved, undefined);
    assert.equal((await getTemplate(pool!, id))?.name, "Mutual NDA");
  });

  test("reports a slug that belongs to another template", async () => {
    await seed("taken");
    const id = await seed("mine");
    const outcome = await submitTemplateUpdate(pool!, { ...form({ slug: "taken" }), id: String(id) });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.errors.slug!, /already used/);
    assert.equal((await getTemplate(pool!, id))?.slug, "mine");
  });

  test("refuses a missing, malformed or archived id with a message and changes nothing", async () => {
    const id = await seed();
    await archiveTemplate(pool!, id);
    for (const bad of [String(id), "999999", "abc", "", "1 or 1=1"]) {
      const outcome = await submitTemplateUpdate(pool!, { ...form({ name: "Hijack" }), id: bad });
      assert.ok("state" in outcome, bad);
      if ("state" in outcome) assert.match(outcome.state.message!, /no longer exists|archived/, bad);
    }
    assert.equal((await getTemplate(pool!, id))?.name, "Mutual NDA");
  });

});

describe("submitArchive", () => {
  test("archives the template and redirects to the list", async () => {
    const created = await createTemplate(pool!, input());
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.deepEqual(await submitArchive(pool!, { id: String(created.id) }), { redirectTo: "/documents/templates" });
    assert.ok((await getTemplate(pool!, created.id))?.archivedAt);
  });

  test("answers a missing, malformed or already archived id with a message", async () => {
    const created = await createTemplate(pool!, input());
    assert.ok(created.ok);
    if (!created.ok) return;
    await archiveTemplate(pool!, created.id);
    for (const bad of [String(created.id), "999999", "x", undefined as unknown as string]) {
      const outcome = await submitArchive(pool!, { id: bad });
      assert.ok("state" in outcome, String(bad));
      if ("state" in outcome) assert.match(outcome.state.message!, /no longer exists|archived/);
    }
  });

});

describe("submitProfile", () => {
  const profileForm = (extra: Record<string, string> = {}) => ({ A_NOMBRE: "Acme Ltd", A_EMAIL: "legal@acme.test", COLOR: "#2563EB", ...extra });

  test("saves the profile and reports it saved with the stored values", async () => {
    const state = await submitProfile(pool!, profileForm({ A_CORTO: "Acme" }));
    assert.equal(state.saved, true);
    assert.deepEqual(state.errors, {});
    assert.equal(state.values.COLOR, "#2563eb");
    assert.deepEqual(await getProfile(pool!), { A_NOMBRE: "Acme Ltd", A_EMAIL: "legal@acme.test", COLOR: "#2563eb", A_CORTO: "Acme" });
  });

  test("blanking a field removes its key and keeps keys the form does not know", async () => {
    await saveProfile(pool!, { set: { A_CORTO: "Acme", CUSTOM: "kept" }, remove: [] });
    await submitProfile(pool!, profileForm({ A_CORTO: "  " }));
    const profile = await getProfile(pool!);
    assert.ok(!("A_CORTO" in profile));
    assert.equal(profile.CUSTOM, "kept");
  });

  test("returns errors and the entered values, and saves nothing, when invalid", async () => {
    const state = await submitProfile(pool!, profileForm({ COLOR: "blue", A_EMAIL: "" }));
    assert.deepEqual(Object.keys(state.errors).sort(), ["A_EMAIL", "COLOR"]);
    assert.equal(state.values.COLOR, "blue");
    assert.equal(state.saved, undefined);
    assert.deepEqual(await getProfile(pool!), {});
  });

});

describe("page loaders", () => {
  test("loads active templates with the profile, and a single template with the profile", async () => {
    await saveProfile(pool!, { set: { A_NOMBRE: "Acme" }, remove: [] });
    const kept = await createTemplate(pool!, input({ slug: "kept" }));
    const gone = await createTemplate(pool!, input({ slug: "gone" }));
    assert.ok(kept.ok && gone.ok);
    if (!kept.ok || !gone.ok) return;
    await archiveTemplate(pool!, gone.id);

    const list = await loadTemplatesData(pool!);
    assert.deepEqual(list.templates.map((t) => t.slug), ["kept"]);
    assert.deepEqual(list.profile, { A_NOMBRE: "Acme" });

    const one = await loadTemplateEditData(pool!, kept.id);
    assert.equal(one.template?.slug, "kept");
    assert.deepEqual(one.profile, { A_NOMBRE: "Acme" });
    assert.equal((await loadTemplateEditData(pool!, gone.id)).template?.archivedAt instanceof Date, true, "an archived template is still loaded so the page can say so");
    assert.equal((await loadTemplateEditData(pool!, 999999)).template, null);
  });

  test("loads the profile as one value per form field, blank when not set", async () => {
    const empty = await loadProfileValues(pool!);
    assert.deepEqual(Object.keys(empty), PROFILE_FIELDS.map((f) => f.key));
    assert.ok(Object.values(empty).every((v) => v === ""));
    await saveProfile(pool!, { set: { A_NOMBRE: "Acme", CUSTOM: "not a form field" }, remove: [] });
    const values = await loadProfileValues(pool!);
    assert.equal(values.A_NOMBRE, "Acme");
    assert.ok(!("CUSTOM" in values));
  });
});
