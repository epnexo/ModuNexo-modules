import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createDocument, fieldsForTemplate } from "../src/create-document.ts";
import { pdfFileName } from "../src/file-store.ts";
import type { PdfEngine } from "../src/pdf-engine.ts";
import { saveProfile } from "../src/profile-store.ts";
import { createTemplate } from "../src/template-store.ts";
import type { VariableSettings } from "../src/variables.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dir: string;
let rendered: string[];
let renders: number;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_create_references"));
});
after(async () => {
  await pool?.end();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-create-references-"));
  rendered = [];
  renders = 0;
  if (!pool) return;
  for (const table of ["documents", "templates", "settings", "counters"]) await pool.query(`delete from documents.${table}`);
});

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(t);
  });

const NOW = new Date(2026, 9, 12, 12, 0);
const engine: PdfEngine = {
  async render(request) {
    renders++;
    rendered.push(request.html);
    await writeFile(request.pdfPath, "%PDF-fake");
    return { ok: true, pages: 1, fields: [] };
  },
};

async function seed(body: string, variables: VariableSettings, counterpartyMarker: string | null = "B_NOMBRE", profile: Record<string, string> = { A_NOMBRE: "Acme Test S.A.", A_CORTO: "Acme" }) {
  await saveProfile(pool!, { set: profile, remove: [] });
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: body, counterpartyMarker }, variables);
  assert.ok(created.ok);
  return created.ok ? created.id : 0;
}
const make = (templateId: number, fields: Record<string, string | undefined>) => createDocument({ db: pool!, engine, dir, now: () => NOW }, { templateId, fields });
const rows = async () => (await pool!.query("select ref, title, counterparty_name, pdf_path, data from documents.documents order by id")).rows;
const counter = async () => (await pool!.query("select last_number from documents.counters where prefix = 'NDA' and year = 2026")).rows[0]?.last_number as number | undefined;
const folder = async () => (await readdir(dir)).sort();

const SIMPLE = "<p>{{REF}} | {{A_NOMBRE}} | {{B_NOMBRE}} | {{B_CORTO}}</p>";

describe("createDocument with values that use other fields", () => {
  test("a document whose values have no references is exactly what it was before", async () => {
    const id = await seed(SIMPLE, {});
    const result = await make(id, { B_NOMBRE: "Beta & Co", B_CORTO: "Beta <b>" });
    assert.ok(result.ok);
    assert.deepEqual(rendered, ["<p>NDA-2026-001 | Acme Test S.A. | Beta &amp; Co | Beta &lt;b&gt;</p>"]);
    const [row] = await rows();
    assert.deepEqual(row.data, { values: { B_NOMBRE: "Beta & Co", B_CORTO: "Beta <b>" }, profile: { A_NOMBRE: "Acme Test S.A." } });
    assert.equal(row.title, "Mutual NDA — Beta & Co");
    assert.equal(row.counterparty_name, "Beta & Co");
    assert.equal(row.pdf_path, pdfFileName("NDA-2026-001", "Beta & Co"));
  });

  test("fills the references with the real reference, the profile and the other fields before the HTML is built", async () => {
    const id = await seed(SIMPLE, {});
    const result = await make(id, { B_NOMBRE: "Beta", B_CORTO: "{{B_NOMBRE}} para {{A_NOMBRE}} ({{REF}})" });
    assert.ok(result.ok);
    assert.deepEqual(rendered, ["<p>NDA-2026-001 | Acme Test S.A. | Beta | Beta para Acme Test S.A. (NDA-2026-001)</p>"]);
  });

  test("stores the resolved values, not the expressions", async () => {
    const id = await seed(SIMPLE, {});
    await make(id, { B_NOMBRE: "Beta", B_CORTO: "{{B_NOMBRE}} / {{REF}}" });
    const [row] = await rows();
    assert.deepEqual(row.data.values, { B_NOMBRE: "Beta", B_CORTO: "Beta / NDA-2026-001" });
  });

  test("stores a profile value a field used even when the body does not use that key", async () => {
    const id = await seed("<p>{{REF}} {{B_NOMBRE}} {{B_CORTO}}</p>", {});
    await make(id, { B_NOMBRE: "Beta", B_CORTO: "{{A_CORTO}}" });
    const [row] = await rows();
    assert.deepEqual(row.data, { values: { B_NOMBRE: "Beta", B_CORTO: "Acme" }, profile: {} });
  });

  test("the title, the counterparty name and the file name use the resolved counterparty value", async () => {
    const id = await seed("<p>{{REF}} {{B_NOMBRE}} {{SUFIJO}}</p>", {});
    const result = await make(id, { B_NOMBRE: "Beta {{SUFIJO}}", SUFIJO: "S.A." });
    assert.ok(result.ok);
    const [row] = await rows();
    assert.equal(row.title, "Mutual NDA — Beta S.A.");
    assert.equal(row.counterparty_name, "Beta S.A.");
    assert.equal(row.pdf_path, pdfFileName("NDA-2026-001", "Beta S.A."));
    assert.deepEqual(await folder(), [row.pdf_path]);
  });

  test("a group typed in a value that is not a known marker is still printed as typed", async () => {
    const id = await seed(SIMPLE, {});
    await make(id, { B_NOMBRE: "Beta", B_CORTO: "{{LIBRE}} {{ A_NOMBRE }}" });
    assert.deepEqual(rendered, ["<p>NDA-2026-001 | Acme Test S.A. | Beta | {{LIBRE}} {{ A_NOMBRE }}</p>"]);
  });

  test("escapes the resolved text once and lets no value inject markup", async () => {
    const id = await seed(SIMPLE, {}, "B_NOMBRE", { A_NOMBRE: `Acme <i>"&'` });
    await make(id, { B_NOMBRE: `Be<ta> {{A_NOMBRE}}`, B_CORTO: "{{B_NOMBRE}} {{B_NOMBRE}}" });
    assert.equal(rendered[0], "<p>NDA-2026-001 | Acme &lt;i&gt;&quot;&amp;&#39; | Be&lt;ta&gt; Acme &lt;i&gt;&quot;&amp;&#39; | Be&lt;ta&gt; Acme &lt;i&gt;&quot;&amp;&#39; Be&lt;ta&gt; Acme &lt;i&gt;&quot;&amp;&#39;</p>");
  });

  test("a cycle is refused on each field of it, with the entries as typed, and nothing is created", async () => {
    const id = await seed(SIMPLE, { B_NOMBRE: { label: "Nombre" }, B_CORTO: { label: "Nombre corto" } });
    const result = await make(id, { B_NOMBRE: "{{B_CORTO}}", B_CORTO: "{{B_NOMBRE}}" });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.kind === "invalid");
    if (result.ok || result.kind !== "invalid") return;
    assert.deepEqual(Object.keys(result.errors).sort(), ["B_CORTO", "B_NOMBRE"]);
    assert.match(result.errors.B_NOMBRE!, /Nombre corto/);
    assert.deepEqual(result.values, { B_NOMBRE: "{{B_CORTO}}", B_CORTO: "{{B_NOMBRE}}" });
    assert.equal(await rows().then((r) => r.length), 0);
    assert.equal(await counter(), undefined, "no number was consumed");
    assert.deepEqual(await folder(), []);
    assert.equal(renders, 0);
  });

  test("a profile value that is not set is a field error and creates nothing", async () => {
    const id = await seed(SIMPLE, {});
    const result = await make(id, { B_NOMBRE: "Beta", B_CORTO: "{{A_REPRESENTANTE}}" });
    assert.ok(!result.ok && result.kind === "invalid");
    assert.deepEqual(!result.ok && result.kind === "invalid" ? Object.keys(result.errors) : [], ["B_CORTO"]);
    assert.equal(await counter(), undefined);
    assert.deepEqual(await folder(), []);
  });

  test("a resolved value longer than its limit is refused on its field and creates nothing", async () => {
    const id = await seed(SIMPLE, {});
    const result = await make(id, { B_NOMBRE: "x".repeat(190), B_CORTO: "{{B_NOMBRE}} {{REF}}" });
    assert.ok(!result.ok && result.kind === "invalid");
    assert.deepEqual(!result.ok && result.kind === "invalid" ? Object.keys(result.errors) : [], ["B_CORTO"]);
    assert.equal(await counter(), undefined);
    assert.equal(renders, 0);
  });

  test("without a counterparty marker the separate name is used as typed and returned as typed on a refusal", async () => {
    const id = await seed(SIMPLE, {}, null);
    const refused = await make(id, { counterpartyName: "Beta {{A_NOMBRE}}", B_NOMBRE: "{{B_CORTO}}", B_CORTO: "{{B_NOMBRE}}" });
    assert.ok(!refused.ok && refused.kind === "invalid");
    assert.equal(!refused.ok && refused.kind === "invalid" ? refused.values.counterpartyName : "", "Beta {{A_NOMBRE}}");
    const made = await make(id, { counterpartyName: "Beta {{A_NOMBRE}}", B_NOMBRE: "x", B_CORTO: "{{B_NOMBRE}}" });
    assert.ok(made.ok);
    assert.equal((await rows())[0].counterparty_name, "Beta {{A_NOMBRE}}", "the separate name is not a marker, so nothing in it is filled");
  });

  test("a failure of the engine after the references were resolved leaves no document, no number and no file", async () => {
    const id = await seed(SIMPLE, {});
    const failing: PdfEngine = { render: async () => ({ ok: false, reason: "render-error" }) };
    const result = await createDocument({ db: pool!, engine: failing, dir, now: () => NOW }, { templateId: id, fields: { B_NOMBRE: "Beta", B_CORTO: "{{B_NOMBRE}}" } });
    assert.ok(!result.ok && result.kind === "render");
    assert.equal((await rows()).length, 0);
    assert.equal(await counter(), undefined);
    assert.deepEqual(await folder(), []);
  });
});

describe("an NDA-shaped document made from the composed defaults", () => {
  const BODY = "<title>{{REF}}</title><style>@page { @bottom-left { content: \"{{PIE}}\"; } }</style><i>{{A_CORTO}}</i><p>{{INTRO}}</p><b>{{B_NOMBRE}}</b><u>{{B_CORTO}}</u><p>{{B_DATOS}}</p><p>{{B_FIRMANTE}}</p><p>{{FECHA}} {{FINALIDAD}}</p>";
  const SETTINGS: VariableSettings = {
    B_NOMBRE: { label: "Nombre de la contraparte" },
    B_CORTO: { label: "Nombre corto de la contraparte", default: "{{B_NOMBRE}}" },
    B_DATOS: { label: "Datos de la contraparte", kind: "text" },
    B_FIRMANTE: { label: "Firmante de la contraparte" },
    INTRO: {
      label: "Introducción",
      kind: "text",
      default: "Antes de compartir información sensible, {{A_CORTO}} y {{B_CORTO}} dejan por escrito cómo la van a proteger. Las mismas reglas aplican a las dos partes.",
    },
    PIE: { label: "Pie", default: "{{A_CORTO}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}" },
    FECHA: { label: "Fecha", kind: "date", locale: "es" },
    FINALIDAD: { label: "Finalidad", default: "evaluar una posible colaboración" },
  };

  test("typing only the counterparty name, data and signer gives the introduction, footer and short name of the skill", async () => {
    const id = await seed(BODY, SETTINGS);
    const { fields } = fieldsForTemplate(BODY, "B_NOMBRE", { A_NOMBRE: "Acme Test S.A.", A_CORTO: "Acme" }, SETTINGS, NOW);
    const typed: Record<string, string> = { B_NOMBRE: "Beta Labs S.A.", B_DATOS: "NIT 123\nCalle 1", B_FIRMANTE: "Ana López · Directora" };
    const submitted = Object.fromEntries(fields.map((field) => [field.name, typed[field.name] ?? field.initial]));
    assert.equal(submitted.B_CORTO, "{{B_NOMBRE}}", "the form starts the short name as the expression");
    const result = await make(id, submitted);
    assert.ok(result.ok);

    const intro = "Antes de compartir información sensible, Acme y Beta Labs S.A. dejan por escrito cómo la van a proteger. Las mismas reglas aplican a las dos partes.";
    const footer = "Acme y Beta Labs S.A. · Acuerdo de confidencialidad NDA-2026-001";
    const [row] = await rows();
    assert.equal(row.data.values.INTRO, intro);
    assert.equal(row.data.values.PIE, footer);
    assert.equal(row.data.values.B_CORTO, "Beta Labs S.A.");
    assert.equal(row.title, "Mutual NDA — Beta Labs S.A.");
    assert.ok(rendered[0]!.includes(`<p>${intro}</p>`));
    assert.ok(rendered[0]!.includes(`content: "${footer}"`));
    assert.ok(rendered[0]!.includes("<u>Beta Labs S.A.</u>"));
    assert.ok(rendered[0]!.includes("<title>NDA-2026-001</title>"));
  });
});
