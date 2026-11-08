import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createDocument } from "../src/create-document.ts";
import { sampleReference } from "../src/document-html.ts";
import { type PdfEngine, type RenderFailure, type RenderResult, createPdfEngine } from "../src/pdf-engine.ts";
import { saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, createTemplate } from "../src/template-store.ts";
import { type PreviewDeps, previewTemplatePdf } from "../web/template-preview-route.ts";
import type { Queryable } from "../web/queries.ts";
import { openMigratedPool } from "./helpers/db.ts";
import { printed } from "./helpers/printed.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let base: string;
let tmpBase: string;
let docsDir: string;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_preview"));
});

after(async () => {
  await pool?.end();
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "documents-preview-test-"));
  tmpBase = join(base, "tmp");
  docsDir = join(base, "documents");
  await mkdir(tmpBase);
  await mkdir(docsDir);
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
  await pool.query("delete from documents.settings");
  await pool.query("delete from documents.counters");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(t);
  });

const BODY = `<p>{{REF}} {{A_NOMBRE}} for {{B_NOMBRE}} on {{FECHA}} {{ bad }} BODYSECRET</p>`;
const PDF = "%PDF-1.7 fake preview";

interface Seen {
  html: string;
  pdfPath: string;
  folderMode: number;
  fileMode: number;
}

/** An engine that records what it was asked, checks the private folder while it runs, and writes a small PDF where it was told to. */
function fakeEngine(outcome: RenderResult = { ok: true, pages: 1, fields: [] }, options: { write?: string | null } = {}) {
  const seen: Seen[] = [];
  const engine: PdfEngine = {
    async render({ html, pdfPath }) {
      const folder = join(pdfPath, "..");
      if (options.write !== null) await writeFile(pdfPath, options.write ?? PDF, { mode: 0o600 });
      seen.push({
        html,
        pdfPath,
        folderMode: (await stat(folder)).mode & 0o777,
        fileMode: options.write === null ? 0 : (await stat(pdfPath)).mode & 0o777,
      });
      return outcome;
    },
  };
  return { engine, seen };
}
const failing = (reason: RenderFailure) => fakeEngine({ ok: false, reason }, { write: "partial" });

async function seed(extra: { body?: string; prefix?: string; slug?: string } = {}) {
  await saveProfile(pool!, { set: { A_NOMBRE: "Acme & <Sons> PROFILESECRET" }, remove: [] });
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: extra.slug ?? "nda", kind: "nda", refPrefix: extra.prefix ?? "NDA", bodyHtml: extra.body ?? BODY, counterpartyMarker: "B_NOMBRE" });
  assert.ok(created.ok);
  return created.ok ? created.id : 0;
}

const preview = (engine: PdfEngine, idParam: string | number, extra: Partial<PreviewDeps> = {}) => previewTemplatePdf({ db: pool!, engine, tmpBase, ...extra }, String(idParam));
const left = async () => (await readdir(tmpBase)).length;
const TABLES = ["documents", "counters", "templates", "settings"] as const;
const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, (await pool!.query(`select * from documents.${table} order by 1`)).rows]))) as Record<string, unknown>;

describe("template preview: success", () => {
  test("answers the PDF inline with private headers, and the engine got the profile, the sample reference and placeholders", async () => {
    const id = await seed();
    const { engine, seen } = fakeEngine();
    const response = await preview(engine, id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="nda-preview.pdf"');
    assert.equal(response.headers.get("content-length"), String(PDF.length));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), PDF);
    assert.equal(seen.length, 1, "one render per request");
    assert.equal(seen[0]!.html, "<p>NDA-YYYY-NNN Acme &amp; &lt;Sons&gt; PROFILESECRET for [B_NOMBRE] on [FECHA] {{ bad }} BODYSECRET</p>");
  });

  test("renders into a private folder under the temporary base and removes it before the answer exists", async () => {
    const id = await seed();
    const { engine, seen } = fakeEngine();
    const response = await preview(engine, id);
    assert.equal(await left(), 0, "nothing is left even though the body was not read yet");
    assert.ok(seen[0]!.pdfPath.startsWith(tmpBase + "/"), "inside the temporary base");
    assert.equal(seen[0]!.folderMode, 0o700, "the folder is private to its owner");
    assert.equal(seen[0]!.fileMode & 0o077, 0, "the file is private to its owner");
    await response.arrayBuffer();
  });

  test("creates no document, takes no number, writes nothing under the documents folder and changes no row", async () => {
    const id = await seed();
    const before = await snapshot();
    const { engine, seen } = fakeEngine();
    for (let i = 0; i < 2; i++) await (await preview(engine, id)).arrayBuffer();
    assert.deepEqual(await snapshot(), before, "no table changed");
    assert.deepEqual(before.documents, []);
    assert.deepEqual(before.counters, []);
    assert.deepEqual(await readdir(docsDir), []);
    assert.ok(seen.every((s) => !s.pdfPath.startsWith(docsDir)));
    assert.equal(await left(), 0);
  });

  test("renders exactly the HTML creation renders when the asked values are the placeholders", async () => {
    const id = await seed();
    const created = fakeEngine();
    const result = await createDocument({ db: pool!, engine: created.engine, dir: docsDir, now: () => new Date("2026-10-09T12:00:00Z") }, { templateId: id, fields: { B_NOMBRE: "[B_NOMBRE]", FECHA: "[FECHA]" } });
    assert.ok(result.ok);
    const previewed = fakeEngine();
    await (await preview(previewed.engine, id)).arrayBuffer();
    assert.equal(previewed.seen[0]!.html, created.seen[0]!.html.replaceAll("NDA-2026-001", sampleReference("NDA")));
  });

  test("still previews a body whose markers are malformed, and uses the template's own prefix", async () => {
    const id = await seed({ body: "<p>{{REF}} {{ x }} {{}} {{lower}}</p>", prefix: "CON" });
    const { engine, seen } = fakeEngine();
    assert.equal((await preview(engine, id)).status, 200);
    assert.equal(seen[0]!.html, "<p>CON-YYYY-NNN {{ x }} {{}} {{lower}}</p>");
  });

  test("keeps the file name safe in the header", async () => {
    const id = await seed({ slug: "a-b_c" });
    const response = await preview(fakeEngine().engine, id);
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="a-b_c-preview.pdf"');
    await response.arrayBuffer();
  });
});

describe("template preview: not found", () => {
  test("answers 404 for a malformed id, an unknown id and an archived template, without rendering", async () => {
    const id = await seed();
    const archived = await createTemplate(pool!, { name: "Old", slug: "old", kind: "other", refPrefix: "OLD", bodyHtml: "x", counterpartyMarker: null });
    assert.ok(archived.ok);
    if (archived.ok) assert.equal(await archiveTemplate(pool!, archived.id), true);
    const { engine, seen } = fakeEngine();
    for (const idParam of ["abc", "0", "-1", "007", "1x", "1 or 1=1", "", "../1", "99999999999999999999", String(id + 1000), archived.ok ? String(archived.id) : "0"]) {
      const response = await preview(engine, idParam);
      assert.equal(response.status, 404, idParam);
      assert.match(response.headers.get("content-type")!, /^text\/plain/);
    }
    assert.equal(seen.length, 0);
    assert.equal(await left(), 0);
  });
});

describe("template preview: failures", () => {
  const cases: [RenderFailure, number][] = [
    ["not-configured", 503],
    ["interpreter-missing", 503],
    ["weasyprint-missing", 503],
    ["timeout", 504],
    ["render-error", 502],
    ["spawn-failed", 502],
  ];
  for (const [reason, status] of cases) {
    test(`answers ${status} in plain text for ${reason}, logs the code only, and leaves nothing behind`, async (t) => {
      const logged: unknown[][] = [];
      t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
      const id = await seed();
      const before = await snapshot();
      const { engine } = failing(reason);
      const response = await preview(engine, id);
      assert.equal(response.status, status);
      assert.match(response.headers.get("content-type")!, /^text\/plain/);
      const text = await response.text();
      if (status === 503) assert.match(text, /DOCUMENTS_PYTHON/);
      assert.doesNotMatch(text, /BODYSECRET|PROFILESECRET|documents-preview/);
      assert.match(printed(logged), new RegExp(reason));
      assert.doesNotMatch(printed(logged), /BODYSECRET|PROFILESECRET|Acme/);
      assert.equal(await left(), 0, "the temporary file is gone");
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await readdir(docsDir), []);
    });
  }

  test("names DOCUMENTS_PYTHON with the real adapter when it is not configured", async (t) => {
    t.mock.method(console, "error", () => {});
    const id = await seed();
    const response = await preview(createPdfEngine({ python: undefined }), id);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /DOCUMENTS_PYTHON/);
    assert.equal(await left(), 0);
  });

  test("answers 500 and removes the folder when the engine throws", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const id = await seed();
    const engine: PdfEngine = {
      async render({ pdfPath }) {
        await writeFile(pdfPath, "partial");
        throw Object.assign(new Error("boom BODYSECRET"), { code: "EBOOM" });
      },
    };
    const response = await preview(engine, id);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /boom|BODYSECRET/);
    assert.match(printed(logged), /EBOOM/);
    assert.doesNotMatch(printed(logged), /boom|BODYSECRET/);
    assert.equal(await left(), 0);
  });

  test("answers 502 when the engine says it worked but wrote no file, and when the file is bigger than the limit", async (t) => {
    t.mock.method(console, "error", () => {});
    const id = await seed();
    assert.equal((await preview(fakeEngine({ ok: true, pages: 1, fields: [] }, { write: null }).engine, id)).status, 502);
    assert.equal((await preview(fakeEngine().engine, id, { maxBytes: 4 })).status, 502);
    assert.equal(await left(), 0);
  });

  test("answers 500 when the temporary folder cannot be made, without rendering", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const id = await seed();
    const { engine, seen } = fakeEngine();
    const response = await preview(engine, id, { tmpBase: join(base, "no", "such", "folder") });
    assert.equal(response.status, 500);
    assert.equal(seen.length, 0);
    assert.match(printed(logged), /ENOENT/);
    assert.doesNotMatch(printed(logged), /no\/such/);
  });

  test("answers 500 in plain text, logging the code only, when the database fails", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const db: Queryable = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db/x"), { code: "ECONNREFUSED" })) };
    const { engine, seen } = fakeEngine();
    const response = await previewTemplatePdf({ db, engine, tmpBase }, "7");
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /hunter2|postgres/);
    assert.match(printed(logged), /ECONNREFUSED/);
    assert.doesNotMatch(printed(logged), /hunter2/);
    assert.equal(seen.length, 0);
    assert.equal(await left(), 0);
  });
});

describe("template preview: the real engine", () => {
  const python = process.env.DOCUMENTS_PYTHON?.trim();

  test("renders a real PDF from the saved body", async (t) => {
    if (!python) return t.skip("DOCUMENTS_PYTHON is not set, so the real WeasyPrint is not available");
    const id = await seed({ body: "<html><body><p>{{REF}} {{A_NOMBRE}} {{B_NOMBRE}}</p></body></html>" });
    const response = await preview(createPdfEngine({ python }), id);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.equal(await left(), 0);
  });
});
