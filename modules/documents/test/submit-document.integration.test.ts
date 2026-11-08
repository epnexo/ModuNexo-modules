import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { type PdfEngine, createPdfEngine } from "../src/pdf-engine.ts";
import { saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, createTemplate } from "../src/template-store.ts";
import { submitNewDocument } from "../web/submit-document.ts";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dir: string;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_submit"));
});
after(async () => {
  await pool?.end();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "documents-submit-"));
  if (!pool) return;
  for (const table of ["documents", "templates", "settings", "counters"]) await pool.query(`delete from documents.${table}`);
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    t.mock.method(console, "error", () => {});
    await run();
  });

const engine: PdfEngine = {
  async render({ pdfPath }) {
    await writeFile(pdfPath, "%PDF-fake");
    return { ok: true, pages: 1, fields: [] };
  },
};
const FIELDS = { B_NOMBRE: "Beta", FECHA: "hoy" };

async function seed(): Promise<string> {
  await saveProfile(pool!, { set: { A_NOMBRE: "Acme" }, remove: [] });
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{REF}} {{A_NOMBRE}} {{B_NOMBRE}} {{FECHA}}</p>", counterpartyMarker: "B_NOMBRE" });
  assert.ok(created.ok);
  return created.ok ? String(created.id) : "";
}
const count = async () => Number((await pool!.query("select count(*) as n from documents.documents")).rows[0].n);

describe("submitNewDocument", () => {
  test("creates the document and redirects to its page", async () => {
    const templateId = await seed();
    const outcome = await submitNewDocument({ db: pool!, engine, dir }, { templateId, ...FIELDS });
    const id = (await pool!.query("select id from documents.documents")).rows[0].id;
    assert.deepEqual(outcome, { redirectTo: `/documents/${id}?created=1` });
  });

  test("returns the field errors and the entered values, and stores nothing", async () => {
    const templateId = await seed();
    const outcome = await submitNewDocument({ db: pool!, engine, dir }, { templateId, B_NOMBRE: "Beta", FECHA: " " });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.deepEqual(Object.keys(outcome.state.errors), ["FECHA"]);
    assert.equal(outcome.state.values.B_NOMBRE, "Beta");
    assert.equal(await count(), 0);
  });

  test("names DOCUMENTS_PYTHON on the form when the engine is not configured, and stores nothing", async () => {
    const templateId = await seed();
    const outcome = await submitNewDocument({ db: pool!, engine: createPdfEngine({ python: undefined }), dir }, { templateId, ...FIELDS });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /PDF engine is not configured/);
    assert.match(outcome.state.message!, /DOCUMENTS_PYTHON/);
    assert.equal(outcome.state.values.B_NOMBRE, "Beta", "the typed values are kept");
    assert.equal(outcome.state.values.templateId, undefined);
    assert.equal(await count(), 0);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(Number((await pool!.query("select count(*) as n from documents.counters")).rows[0].n), 0);
  });

  test("names the markers that have no value, keeps the typed values and stores nothing", async () => {
    const templateId = await seed();
    let reads = 0;
    const profile = { get A_NOMBRE() { return reads++ < 2 ? "Acme" : undefined; } };
    const db = { query: (text: string, values?: unknown[]) => (text.includes("documents.settings") ? Promise.resolve({ rows: [{ profile }] }) : pool!.query(text, values)), connect: () => pool!.connect() };
    const outcome = await submitNewDocument({ db: db as never, engine, dir }, { templateId, ...FIELDS });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /A_NOMBRE/);
    assert.equal(outcome.state.values.B_NOMBRE, "Beta");
    assert.equal(await count(), 0);
    assert.deepEqual(await readdir(dir), []);
  });

  test("answers a missing or malformed template id with a message", async () => {
    await seed();
    for (const templateId of ["999999", "abc", "", undefined as unknown as string]) {
      const outcome = await submitNewDocument({ db: pool!, engine, dir }, { templateId, ...FIELDS });
      assert.ok("state" in outcome, String(templateId));
      if ("state" in outcome) assert.match(outcome.state.message!, /no longer exists|archived/);
    }
  });

  test("answers an archived template with a message and stores nothing", async () => {
    const templateId = await seed();
    assert.equal(await archiveTemplate(pool!, Number(templateId)), true);
    const outcome = await submitNewDocument({ db: pool!, engine, dir }, { templateId, ...FIELDS });
    assert.ok("state" in outcome);
    if ("state" in outcome) assert.match(outcome.state.message!, /archived/);
    assert.equal(await count(), 0);
    assert.deepEqual(await readdir(dir), []);
  });

  test("answers a file system error with a plain message and no path", async () => {
    const templateId = await seed();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const outcome = await submitNewDocument({ db: pool!, engine, dir: join(blocker, "inside") }, { templateId, ...FIELDS });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /could not be stored/);
    assert.doesNotMatch(outcome.state.message!, new RegExp(dir));
    assert.equal(await count(), 0);
  });

  test("answers a database failure with a safe message and keeps the values", async () => {
    const down = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db.internal/x"), { code: "ECONNREFUSED" })), connect: async () => Promise.reject(new Error("down")) };
    const outcome = await submitNewDocument({ db: down, engine, dir }, { templateId: "1", ...FIELDS });
    assert.ok("state" in outcome);
    if (!("state" in outcome)) return;
    assert.match(outcome.state.message!, /unreachable/);
    assert.doesNotMatch(JSON.stringify(outcome), /hunter2|db\.internal/);
    assert.equal(outcome.state.values.B_NOMBRE, "Beta");
  });
});
