import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createDocument, fieldsForTemplate } from "../src/create-document.ts";
import type { PdfEngine } from "../src/pdf-engine.ts";
import { saveProfile } from "../src/profile-store.ts";
import { createTemplate } from "../src/template-store.ts";
import type { VariableSettings } from "../src/variables.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dir: string;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_create_variables"));
});
after(async () => {
  await pool?.end();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-create-variables-"));
  if (!pool) return;
  for (const table of ["documents", "templates", "settings", "counters"]) await pool.query(`delete from documents.${table}`);
});

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(t);
  });

const BODY = "<p>{{REF}} {{A_NOMBRE}} for {{B_NOMBRE}} on {{FECHA}}: {{FINALIDAD}}</p>";
const NOW = new Date(2026, 9, 12, 21, 30);
const SETTINGS: VariableSettings = {
  B_NOMBRE: { label: "Nombre de la contraparte", help: "Razón social" },
  FECHA: { label: "Fecha de efectos", kind: "date", locale: "es" },
  FINALIDAD: { label: "Finalidad", kind: "line", default: "evaluar una colaboración" },
};

const engine: PdfEngine = {
  async render(request) {
    await writeFile(request.pdfPath, "%PDF-fake");
    return { ok: true, pages: 1, fields: [] };
  },
};

async function seed(variables: VariableSettings) {
  await saveProfile(pool!, { set: { A_NOMBRE: "Acme" }, remove: [] });
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: BODY, counterpartyMarker: "B_NOMBRE" }, variables);
  assert.ok(created.ok);
  return created.ok ? created.id : 0;
}
const make = (templateId: number, fields: Record<string, string | undefined>) => createDocument({ db: pool!, engine, dir, now: () => NOW }, { templateId, fields });
const count = async () => Number((await pool!.query("select count(*) as n from documents.documents")).rows[0].n);

describe("fieldsForTemplate with variable settings", () => {
  test("labels, hints and starts the fields from the settings, the counterparty name first", async () => {
    const { fields, counterpartyMarker } = fieldsForTemplate(BODY, "B_NOMBRE", { A_NOMBRE: "Acme" }, SETTINGS, NOW);
    assert.equal(counterpartyMarker, "B_NOMBRE");
    assert.deepEqual(
      fields.map((f) => [f.name, f.label, f.hint, f.kind, f.initial]),
      [
        ["B_NOMBRE", "Nombre de la contraparte", "Razón social", "line", ""],
        ["FECHA", "Fecha de efectos", null, "date", "12 de octubre de 2026"],
        ["FINALIDAD", "Finalidad", null, "line", "evaluar una colaboración"],
      ],
    );
  });

  test("never offers settings for a profile marker or for REF", async () => {
    const { fields } = fieldsForTemplate(BODY, null, { A_NOMBRE: "Acme" }, { A_NOMBRE: { label: "Profile" }, REF: { label: "Ref" } }, NOW);
    assert.deepEqual(fields.map((f) => f.name), ["counterpartyName", "B_NOMBRE", "FECHA", "FINALIDAD"]);
  });
});

describe("createDocument with variable settings", () => {
  test("a default is only a starting value: a document needs every value to be submitted", async () => {
    const id = await seed(SETTINGS);
    const result = await make(id, { B_NOMBRE: "Beta", FECHA: "12 de octubre de 2026" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind === "invalid" && Object.keys(result.errors).join(), "FINALIDAD");
    assert.equal(await count(), 0);
  });

  test("creates the document from the submitted values, defaults included once the form sent them", async () => {
    const id = await seed(SETTINGS);
    const result = await make(id, { B_NOMBRE: "Beta", FECHA: "12 de octubre de 2026", FINALIDAD: "evaluar una colaboración" });
    assert.ok(result.ok);
    const row = (await pool!.query("select data from documents.documents")).rows[0];
    assert.deepEqual(row.data.values, { B_NOMBRE: "Beta", FECHA: "12 de octubre de 2026", FINALIDAD: "evaluar una colaboración" });
  });

  test("takes the limits from the effective kind of the settings", async () => {
    const id = await seed({ ...SETTINGS, B_NOMBRE: { kind: "text" } });
    const long = "x".repeat(300);
    assert.equal((await make(id, { B_NOMBRE: long, FECHA: "a", FINALIDAD: "b" })).ok, true, "a long-text name takes 300 characters");
    const tooLong = await make(id, { B_NOMBRE: "ok", FECHA: "a", FINALIDAD: long });
    assert.equal(tooLong.ok, false, "a line value over 200 characters is refused although FINALIDAD is a paragraph by name");
    assert.equal(!tooLong.ok && tooLong.kind === "invalid" && Object.keys(tooLong.errors).join(), "FINALIDAD");
  });

  test("a date value is stored as the text that was submitted", async () => {
    const id = await seed(SETTINGS);
    await make(id, { B_NOMBRE: "Beta", FECHA: "next Tuesday", FINALIDAD: "x" });
    assert.equal((await pool!.query("select data->'values'->>'FECHA' as v from documents.documents")).rows[0].v, "next Tuesday");
  });
});
