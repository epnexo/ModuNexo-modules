import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, createTemplate, getTemplate } from "../src/template-store.ts";
import type { VariableSettings } from "../src/variables.ts";
import { submitNewTemplate, submitTemplateUpdate } from "../web/submit.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_template_variables"));
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  if (!pool) return;
  for (const table of ["documents", "templates", "settings"]) await pool.query(`delete from documents.${table}`);
  await saveProfile(pool, { set: { A_NOMBRE: "Acme" }, remove: [] });
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const BODY = "<p>{{REF}} {{A_NOMBRE}} {{B_NOMBRE}} {{FECHA}} {{PIE}}</p>";
const form = (extra: Record<string, string> = {}) => ({ name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: BODY, counterpartyMarker: "", ...extra });
const seed = async (variables: VariableSettings = {}, bodyHtml = BODY) => {
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml, counterpartyMarker: null }, variables);
  assert.ok(created.ok);
  return created.ok ? created.id : 0;
};
const update = async (id: number, raw: Record<string, string>) => {
  const outcome = await submitTemplateUpdate(pool!, { ...raw, id: String(id) });
  assert.ok("state" in outcome);
  return "state" in outcome ? outcome.state : (undefined as never);
};

describe("saving a template with its variables", () => {
  test("stores the settings submitted for the markers the body asks, and shows the normalized rows", async () => {
    const id = await seed();
    const state = await update(id, form({
      "variables.B_NOMBRE.label": " Nombre de la contraparte ",
      "variables.B_NOMBRE.help": "Razón social",
      "variables.B_NOMBRE.kind": "",
      "variables.B_NOMBRE.default": "",
      "variables.B_NOMBRE.locale": "es",
      "variables.FECHA.label": "Fecha de efectos",
      "variables.FECHA.kind": "date",
      "variables.FECHA.locale": "en",
    }));
    assert.equal(state.saved, true);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, {
      B_NOMBRE: { label: "Nombre de la contraparte", help: "Razón social" },
      FECHA: { label: "Fecha de efectos", kind: "date", locale: "en" },
    });
    assert.deepEqual(state.variables?.map((r) => [r.marker, r.label, r.kind, r.locale]), [
      ["B_NOMBRE", "Nombre de la contraparte", "", "es"],
      ["FECHA", "Fecha de efectos", "date", "en"],
      ["PIE", "", "", "es"],
    ]);
    assert.deepEqual(state.dropped, []);
  });

  test("saves a default that uses other fields, the profile and REF, as written", async () => {
    const id = await seed();
    const state = await update(id, form({ "variables.PIE.default": "{{A_NOMBRE}} y {{B_NOMBRE}} · {{REF}}" }));
    assert.equal(state.saved, true, JSON.stringify(state.variableErrors));
    assert.equal((await getTemplate(pool!, id))?.variables.PIE?.default, "{{A_NOMBRE}} y {{B_NOMBRE}} · {{REF}}");
  });

  test("refuses a default that names a marker the template does not know, or a cycle, and writes nothing", async () => {
    const id = await seed({ B_NOMBRE: { label: "Stored" } });
    const unknown = await update(id, form({ "variables.PIE.default": "{{NOPE}}" }));
    assert.deepEqual(Object.keys(unknown.variableErrors ?? {}), ["PIE.default"]);
    assert.match(unknown.variableErrors?.["PIE.default"] ?? "", /NOPE/);
    const cycle = await update(id, form({ "variables.PIE.default": "{{FECHA}}", "variables.FECHA.default": "{{PIE}}" }));
    assert.deepEqual(Object.keys(cycle.variableErrors ?? {}).sort(), ["FECHA.default", "PIE.default"]);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { B_NOMBRE: { label: "Stored" } });
  });

  test("a form that sends no variable inputs leaves the stored settings alone", async () => {
    const id = await seed({ B_NOMBRE: { label: "Kept" } });
    const state = await update(id, form({ name: "Renamed" }));
    assert.equal(state.saved, true);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { B_NOMBRE: { label: "Kept" } });
    assert.equal(state.variables?.find((r) => r.marker === "B_NOMBRE")?.label, "Kept");
  });

  test("clearing every input of a row removes its settings", async () => {
    const id = await seed({ B_NOMBRE: { label: "Old", help: "old" } });
    await update(id, form({ "variables.B_NOMBRE.label": "", "variables.B_NOMBRE.help": "", "variables.B_NOMBRE.kind": "", "variables.B_NOMBRE.default": "", "variables.B_NOMBRE.locale": "es" }));
    assert.deepEqual((await getTemplate(pool!, id))?.variables, {});
  });

  test("drops the settings of a marker removed from the body and names it in the report", async () => {
    const id = await seed({ B_NOMBRE: { label: "Nombre" }, PIE: { label: "Pie de página" } });
    const state = await update(id, form({ bodyHtml: "<p>{{REF}} {{B_NOMBRE}}</p>", "variables.B_NOMBRE.label": "Nombre", "variables.PIE.label": "Pie de página" }));
    assert.equal(state.saved, true);
    assert.deepEqual(state.dropped, ["PIE"]);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { B_NOMBRE: { label: "Nombre" } });
    assert.deepEqual(state.variables?.map((r) => r.marker), ["B_NOMBRE"], "the section now follows the body just saved");
  });

  test("a marker added to the body appears in the rows after the save, with nothing set", async () => {
    const id = await seed({}, "<p>{{B_NOMBRE}}</p>");
    const state = await update(id, form({ bodyHtml: "<p>{{B_NOMBRE}} {{NUEVO}}</p>", "variables.B_NOMBRE.label": "Nombre" }));
    assert.deepEqual(state.variables?.map((r) => [r.marker, r.label]), [["B_NOMBRE", "Nombre"], ["NUEVO", ""]]);
  });

  test("keeps no settings for a profile marker or REF even when the form sends them", async () => {
    const id = await seed();
    const state = await update(id, form({ "variables.A_NOMBRE.label": "Profile", "variables.REF.label": "Ref", "variables.PIE.label": "Pie" }));
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { PIE: { label: "Pie" } });
    assert.deepEqual(state.dropped, ["A_NOMBRE", "REF"]);
  });

  test("returns the errors next to their rows, keeps what was typed, and writes nothing", async () => {
    const id = await seed({ B_NOMBRE: { label: "Stored" } });
    const state = await update(id, form({ name: "Renamed", "variables.B_NOMBRE.label": "x".repeat(81), "variables.FECHA.default": "{{NOT_A_MARKER}}", "variables.PIE.label": "Typed" }));
    assert.equal(state.saved, undefined);
    assert.deepEqual(Object.keys(state.variableErrors ?? {}).sort(), ["B_NOMBRE.label", "FECHA.default"]);
    assert.equal(state.variables?.find((r) => r.marker === "B_NOMBRE")?.label, "x".repeat(81));
    assert.equal(state.variables?.find((r) => r.marker === "PIE")?.label, "Typed");
    assert.equal(state.values.name, "Renamed");
    const stored = await getTemplate(pool!, id);
    assert.equal(stored?.name, "Mutual NDA");
    assert.deepEqual(stored?.variables, { B_NOMBRE: { label: "Stored" } });
  });

  test("a template field error returns the submitted rows too, so nothing typed is lost", async () => {
    const id = await seed();
    const state = await update(id, form({ name: "", "variables.PIE.label": "Typed" }));
    assert.ok(state.errors.name);
    assert.equal(state.variables?.find((r) => r.marker === "PIE")?.label, "Typed");
  });

  test("a slug that is taken keeps the submitted rows and writes no settings", async () => {
    await seed();
    const other = await createTemplate(pool!, { name: "Other", slug: "other", kind: "nda", refPrefix: "OT", bodyHtml: BODY, counterpartyMarker: null });
    assert.ok(other.ok);
    if (!other.ok) return;
    const state = await update(other.id, form({ slug: "nda", "variables.PIE.label": "Typed" }));
    assert.match(state.errors.slug!, /already used/);
    assert.equal(state.variables?.find((r) => r.marker === "PIE")?.label, "Typed");
    assert.deepEqual((await getTemplate(pool!, other.id))?.variables, {});
  });

  test("an archived or missing template is refused before any settings are read or written", async () => {
    const id = await seed({ PIE: { label: "Kept" } });
    await archiveTemplate(pool!, id);
    const state = await update(id, form({ "variables.PIE.label": "Hijack" }));
    assert.match(state.message!, /no longer exists|archived/);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { PIE: { label: "Kept" } });
    const missing = await submitTemplateUpdate(pool!, { ...form(), id: "999999" });
    assert.ok("state" in missing && /no longer exists|archived/.test(missing.state.message ?? ""));
  });

  test("a counterparty marker still has to be a marker of the body, and may carry a label", async () => {
    const id = await seed();
    const state = await update(id, form({ counterpartyMarker: "B_NOMBRE", "variables.B_NOMBRE.label": "Nombre de la contraparte" }));
    assert.equal(state.saved, true);
    assert.equal((await getTemplate(pool!, id))?.counterpartyMarker, "B_NOMBRE");
  });

  test("stores text with quotes and braces as typed, never interpreting it", async () => {
    const id = await seed();
    await update(id, form({ "variables.PIE.label": `It's "x" <b>&</b>`, "variables.PIE.help": "{x} ' ; drop table" }));
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { PIE: { label: `It's "x" <b>&</b>`, help: "{x} ' ; drop table" } });
  });

  test("creating a template does not take settings: they need the saved body", async () => {
    const outcome = await submitNewTemplate(pool!, form({ "variables.PIE.label": "Ignored" }));
    assert.ok("redirectTo" in outcome);
    assert.deepEqual((await getTemplate(pool!, Number(/templates\/(\d+)/.exec((outcome as { redirectTo: string }).redirectTo)![1])))?.variables, {});
  });
});
