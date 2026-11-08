import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createDocument, fieldsForTemplate } from "../src/create-document.ts";
import { substitute } from "../src/markers.ts";
import type { PdfEngine, RenderFailure, RenderResult } from "../src/pdf-engine.ts";
import type { Transactional } from "../src/transaction.ts";
import { saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, createTemplate } from "../src/template-store.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dir: string;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_create"));
});

after(async () => {
  await pool?.end();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-create-"));
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
  await pool.query("delete from documents.settings");
  await pool.query("delete from documents.counters");
});

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(t);
  });

const BODY = `<p>{{REF}} {{A_NOMBRE}} for {{B_NOMBRE}} on {{FECHA}}</p><div data-campo="firma-1"></div>`;
const FIELDS = { B_NOMBRE: "Beta <Ltd> & Co", FECHA: "9 de octubre de 2026" };
const NOW = () => new Date("2026-10-09T12:00:00Z");

/** An engine that records what it was asked and writes a small file where it was told to. */
function fakeEngine(outcome: RenderResult = { ok: true, pages: 3, fields: [{ id: "firma-1", page: 2, x: 0.1, y: 0.4, w: 0.38, h: 0.07 }] }) {
  const calls: { html: string; pdfPath: string }[] = [];
  const engine: PdfEngine = {
    async render(request) {
      calls.push(request);
      await writeFile(request.pdfPath, "%PDF-fake");
      return outcome;
    },
  };
  return { engine, calls };
}
const failing = (reason: RenderFailure) => fakeEngine({ ok: false, reason });

async function seed(extra: { body?: string; counterpartyMarker?: string | null; slug?: string } = {}) {
  await saveProfile(pool!, { set: { A_NOMBRE: "Acme & <Sons>", COLOR: "#112233" }, remove: [] });
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: extra.slug ?? "nda", kind: "nda", refPrefix: "NDA", bodyHtml: extra.body ?? BODY, counterpartyMarker: "counterpartyMarker" in extra ? extra.counterpartyMarker! : "B_NOMBRE" });
  assert.ok(created.ok);
  return created.ok ? created.id : 0;
}

const make = (templateId: number, engine: PdfEngine, fields: Record<string, string | undefined> = FIELDS) => createDocument({ db: pool!, engine, dir, now: NOW }, { templateId, fields });
const count = async (table: string) => Number((await pool!.query(`select count(*) as n from documents.${table}`)).rows[0].n);
const lastNumber = async () => (await pool!.query("select last_number from documents.counters where prefix = 'NDA' and year = 2026")).rows[0]?.last_number as number | undefined;
const files = async () => (await readdir(dir)).sort();

describe("createDocument: success", () => {
  test("numbers the document, renders it, stores the row and the file, and answers with the id and reference", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    const result = await make(id, engine);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.ref, "NDA-2026-001");

    const row = (await pool!.query("select * from documents.documents where id = $1", [result.id])).rows[0];
    assert.equal(row.ref, "NDA-2026-001");
    assert.equal(row.title, "Mutual NDA — Beta <Ltd> & Co");
    assert.equal(row.counterparty_name, "Beta <Ltd> & Co");
    assert.equal(row.status, "generated");
    assert.equal(Number(row.template_id), id);
    assert.equal(row.template_body_snapshot, BODY);
    assert.equal(row.pdf_path, "NDA-2026-001-beta-ltd-co.pdf");
    assert.deepEqual(row.signature_fields, { pages: 3, fields: [{ id: "firma-1", page: 2, x: 0.1, y: 0.4, w: 0.38, h: 0.07 }] });
    assert.equal(await readFile(join(dir, row.pdf_path), "utf8"), "%PDF-fake");
    assert.deepEqual(await files(), ["NDA-2026-001-beta-ltd-co.pdf"], "no temporary file is left");
    assert.equal((await stat(join(dir, row.pdf_path))).mode & 0o077, 0, "the file is private to its owner");
    assert.equal(calls.length, 1);
  });

  test("fills REF, the profile and the values with escaping; a marker typed in a value is filled once, a group that names no marker stays as typed", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    await make(id, engine, { B_NOMBRE: "{{A_NOMBRE}} {{NOT_ONE}}", FECHA: "<script>1</script>" });
    assert.equal(calls[0]!.html, `<p>NDA-2026-001 Acme &amp; &lt;Sons&gt; for Acme &amp; &lt;Sons&gt; {{NOT_ONE}} on &lt;script&gt;1&lt;/script&gt;</p><div data-campo="firma-1"></div>`);
  });

  test("stores the values and the profile values it used, so the document can be rebuilt after the profile changes", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    const result = await make(id, engine);
    assert.ok(result.ok);
    if (!result.ok) return;
    const row = (await pool!.query("select data, template_body_snapshot, ref from documents.documents where id = $1", [result.id])).rows[0];
    assert.deepEqual(row.data, { values: FIELDS, profile: { A_NOMBRE: "Acme & <Sons>" } }, "only the profile keys the body uses");
    await saveProfile(pool!, { set: { A_NOMBRE: "Changed Name" }, remove: [] });
    const rebuilt = substitute(row.template_body_snapshot, { ...row.data.profile, ...row.data.values, REF: row.ref });
    assert.deepEqual(rebuilt, { html: calls[0]!.html, missing: [] });
  });

  test("asks for the counterparty name on its own field when the template names no marker", async () => {
    const id = await seed({ body: `<p>{{REF}} {{FECHA}}</p>`, counterpartyMarker: null });
    const { engine } = fakeEngine();
    const result = await make(id, engine, { counterpartyName: "Gamma SA", FECHA: "hoy" });
    assert.ok(result.ok);
    const row = (await pool!.query("select counterparty_name, title, data from documents.documents")).rows[0];
    assert.deepEqual([row.counterparty_name, row.title], ["Gamma SA", "Mutual NDA — Gamma SA"]);
    assert.deepEqual(row.data, { values: { FECHA: "hoy" }, profile: {} });
  });

  test("takes the year from the creation date, and keeps a separate counter per year", async () => {
    const id = await seed();
    const { engine } = fakeEngine();
    const later = await createDocument({ db: pool!, engine, dir, now: () => new Date("2027-01-02T00:00:00Z") }, { templateId: id, fields: FIELDS });
    assert.equal(later.ok && later.ref, "NDA-2027-001");
    assert.equal((await make(id, engine)).ok && true, true);
    assert.equal((await pool!.query("select ref from documents.documents order by id")).rows.map((r) => r.ref).join(), "NDA-2027-001,NDA-2026-001");
  });

  test("gives parallel creations distinct, consecutive numbers and one file each", async () => {
    const id = await seed();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => make(id, fakeEngine().engine, { ...FIELDS, B_NOMBRE: `Party ${i}` })));
    assert.ok(results.every((r) => r.ok));
    assert.deepEqual(results.map((r) => (r.ok ? r.ref : "")).sort(), ["NDA-2026-001", "NDA-2026-002", "NDA-2026-003", "NDA-2026-004"]);
    assert.equal((await files()).length, 4);
    assert.equal(await lastNumber(), 4);
  });

  test("creates the documents folder on demand", async () => {
    const id = await seed();
    const nested = join(dir, "nested", "documents");
    const result = await createDocument({ db: pool!, engine: fakeEngine().engine, dir: nested, now: NOW }, { templateId: id, fields: FIELDS });
    assert.ok(result.ok);
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
  });
});

describe("createDocument: nothing is stored when it fails", () => {
  const assertNothingLeft = async () => {
    assert.equal(await count("documents"), 0, "no row");
    assert.deepEqual(await files(), [], "no file, temporary or final");
    assert.equal(await lastNumber(), undefined, "no number consumed");
  };

  for (const reason of ["not-configured", "interpreter-missing", "weasyprint-missing", "render-error", "timeout"] as const) {
    test(`a ${reason} result leaves no row, no file and no consumed number, and the next document is number 1`, async () => {
      const id = await seed();
      const result = await make(id, failing(reason).engine);
      assert.deepEqual(result, { ok: false, kind: "render", reason });
      await assertNothingLeft();
      const next = await make(id, fakeEngine().engine);
      assert.equal(next.ok && next.ref, "NDA-2026-001");
    });
  }

  test("an engine that throws leaves nothing and the error reaches the caller", async () => {
    const id = await seed();
    const engine: PdfEngine = { render: async (request) => (await writeFile(request.pdfPath, "half"), Promise.reject(new Error("engine crashed"))) };
    await assert.rejects(make(id, engine), /engine crashed/);
    await assertNothingLeft();
  });

  test("a database error after the render removes the file and gives the number back", async () => {
    const id = await seed();
    await pool!.query("insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name) values ('NDA-2026-001', $1, 'x', 't', 'c')", [id]);
    await assert.rejects(make(id, fakeEngine().engine), { code: "23505" });
    assert.deepEqual(await files(), []);
    assert.equal(await lastNumber(), undefined);
    assert.equal(await count("documents"), 1);
  });

  test("a file that cannot be moved into place leaves nothing", async () => {
    const id = await seed();
    await mkdir(join(dir, "NDA-2026-001-beta-ltd-co.pdf"));
    await assert.rejects(make(id, fakeEngine().engine));
    assert.equal(await count("documents"), 0);
    assert.equal(await lastNumber(), undefined);
    assert.deepEqual(await files(), ["NDA-2026-001-beta-ltd-co.pdf"], "only the folder the test made");
  });

  test("a folder that cannot be written to fails cleanly", async (t) => {
    // Permission bits do not stop the superuser, so there is nothing to observe as uid 0.
    if (process.getuid?.() === 0) return t.skip("running as uid 0, which can write to a read-only folder");
    const id = await seed();
    await chmod(dir, 0o500);
    try {
      await assert.rejects(make(id, fakeEngine().engine));
    } finally {
      await chmod(dir, 0o700);
    }
    assert.equal(await count("documents"), 0);
    assert.equal(await lastNumber(), undefined);
  });
});

/**
 * A pool whose COMMIT fails after the file was moved into place. `committed` says whether the server really committed
 * before the failure was reported, as can happen when the connection drops while the answer is on its way.
 */
function failingCommit(how: { committed: boolean; code?: string; verifyFails?: boolean }): Transactional {
  const error = () => Object.assign(new Error(how.code ? "could not serialize access" : "Connection terminated unexpectedly"), how.code ? { code: how.code } : {});
  return {
    query: (text: string, values?: unknown[]) => (how.verifyFails && text.includes("where ref") ? Promise.reject(new Error("still down")) : pool!.query(text, values)),
    async connect() {
      const client = await pool!.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          if (text !== "commit") return client.query(text, values);
          await client.query(how.committed ? "commit" : "rollback");
          throw error();
        },
        release: (broken?: Error | boolean) => client.release(broken),
      };
    },
  } as unknown as Transactional;
}
const makeWith = (db: Transactional, templateId: number, engine: PdfEngine = fakeEngine().engine) => createDocument({ db, engine, dir, now: NOW }, { templateId, fields: FIELDS });

describe("createDocument: the commit fails after the PDF was moved into place", () => {
  test("a commit that did not happen leaves no row, no final file and no consumed number", async () => {
    const id = await seed();
    await assert.rejects(makeWith(failingCommit({ committed: false }), id), /Connection terminated/);
    assert.equal(await count("documents"), 0);
    assert.deepEqual(await files(), []);
    assert.equal(await lastNumber(), undefined);
  });

  test("a commit refused by the server with an error code is a certain rollback: the file goes", async () => {
    const id = await seed();
    await assert.rejects(makeWith(failingCommit({ committed: false, code: "40001", verifyFails: true }), id), { code: "40001" });
    assert.deepEqual(await files(), []);
    assert.equal(await count("documents"), 0);
  });

  test("a commit that did happen although the failure was reported keeps the file and answers with the document", async () => {
    const id = await seed();
    const result = await makeWith(failingCommit({ committed: true }), id);
    assert.ok(result.ok, "the row exists, so the document was created");
    assert.deepEqual(await files(), ["NDA-2026-001-beta-ltd-co.pdf"]);
    assert.equal(await count("documents"), 1);
    assert.equal(await lastNumber(), 1);
  });

  test("when the outcome cannot be found out, the file stays: a file without a row is harmless, a row without its file is not", async () => {
    const id = await seed();
    await assert.rejects(makeWith(failingCommit({ committed: true, verifyFails: true }), id), /Connection terminated/);
    assert.deepEqual(await files(), ["NDA-2026-001-beta-ltd-co.pdf"]);
    assert.equal(await count("documents"), 1);
  });
});

describe("createDocument: a marker that ends up without a value", () => {
  /** A profile that reads as a string while the form is checked (twice per marker) and as nothing after, which the checks of the form cannot see. Defensive only: no stored profile does this. */
  const shifting = (): Transactional => {
    let reads = 0;
    const profile = { get A_NOMBRE() { return reads++ < 2 ? "Acme" : undefined; } };
    return {
      query: (text: string, values?: unknown[]) => (text.includes("documents.settings") ? Promise.resolve({ rows: [{ profile }] }) : pool!.query(text, values)),
      connect: () => pool!.connect(),
    } as unknown as Transactional;
  };

  test("returns a typed failure naming the marker, takes no number and leaves no file", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    const result = await makeWith(shifting(), id, engine);
    assert.deepEqual(result, { ok: false, kind: "unfilled", markers: ["A_NOMBRE"] });
    assert.equal(calls.length, 0, "nothing was rendered");
    assert.equal(await lastNumber(), undefined, "no number consumed");
    assert.deepEqual(await files(), []);
    assert.equal(await count("documents"), 0);
  });
});

describe("createDocument: input is checked before anything is taken", () => {
  test("answers each missing or invalid value, keeps what was entered, and never renders or takes a number", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    const result = await make(id, engine, { B_NOMBRE: "Beta", FECHA: "", EXTRA: "x" });
    assert.equal(result.ok, false);
    if (result.ok || result.kind !== "invalid") return assert.fail("expected invalid");
    assert.deepEqual(Object.keys(result.errors), ["FECHA"]);
    assert.equal(result.values.B_NOMBRE, "Beta");
    assert.equal(calls.length, 0);
    assert.equal(await lastNumber(), undefined);
  });

  test("ignores a forged REF or profile value in the input", async () => {
    const id = await seed();
    const { engine, calls } = fakeEngine();
    await make(id, engine, { ...FIELDS, REF: "FORGED-1", A_NOMBRE: "Forged" });
    assert.match(calls[0]!.html, /NDA-2026-001 Acme/);
    assert.doesNotMatch(calls[0]!.html, /FORGED|Forged/);
  });

  test("refuses a template that is missing or archived", async () => {
    const id = await seed();
    await archiveTemplate(pool!, id);
    const { engine, calls } = fakeEngine();
    assert.deepEqual(await make(id, engine), { ok: false, kind: "template-unavailable" });
    assert.deepEqual(await make(999999, engine), { ok: false, kind: "template-unavailable" });
    assert.equal(calls.length, 0);
  });

  test("leaves a group that is not a valid marker as written", async () => {
    const id = await seed({ body: `<p>{{REF}} {{B_NOMBRE}} {{FECHA}} {{ bad }}</p>` });
    const { engine, calls } = fakeEngine();
    const result = await make(id, engine);
    assert.ok(result.ok);
    assert.match(calls[0]!.html, /\{\{ bad \}\}/);
  });
});

describe("fieldsForTemplate", () => {
  it("falls back to a separate counterparty field when the chosen marker is not a per-document marker", () => {
    assert.equal(fieldsForTemplate("{{B_NOMBRE}} {{A_NOMBRE}}", "B_NOMBRE", {}).counterpartyMarker, "B_NOMBRE");
    assert.equal(fieldsForTemplate("{{B_NOMBRE}}", "B_NOMBRE", { B_NOMBRE: "profile" }).counterpartyMarker, null);
    assert.equal(fieldsForTemplate("{{X}}", "B_NOMBRE", {}).counterpartyMarker, null);
    assert.equal(fieldsForTemplate("{{X}}", null, {}).fields[0]!.name, "counterpartyName");
  });
});
