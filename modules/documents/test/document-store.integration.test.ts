import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { getDocument, getDocumentPdfPath, insertGeneratedDocument } from "../src/document-store.ts";
import { createTemplate } from "../src/template-store.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_docstore"));
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

async function insert(extra: { ref?: string; pdfPath?: string } = {}) {
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>x</p>", counterpartyMarker: null });
  assert.ok(created.ok);
  const templateId = created.ok ? created.id : 0;
  const id = await insertGeneratedDocument(pool!, {
    ref: extra.ref ?? "NDA-2026-001",
    templateId,
    templateBodySnapshot: "<p>x</p>",
    title: "Mutual NDA — Beta",
    counterpartyName: "Beta",
    data: { values: { B_NOMBRE: "Beta" }, profile: { A_NOMBRE: "Acme" } },
    pdfPath: extra.pdfPath ?? "NDA-2026-001-beta.pdf",
    signatureFields: { pages: 3, fields: [] },
  });
  return id;
}

describe("document store", () => {
  test("reads a document with its template name, values, profile values and page count", async () => {
    const id = await insert();
    const document = await getDocument(pool!, id);
    assert.ok(document);
    assert.deepEqual(
      { ...document, createdAt: undefined },
      { id, ref: "NDA-2026-001", title: "Mutual NDA — Beta", counterpartyName: "Beta", templateName: "Mutual NDA", status: "generated", createdAt: undefined, pages: 3,
        values: { B_NOMBRE: "Beta" },
        profile: { A_NOMBRE: "Acme" },
        templateVariables: {},
        hasPdf: true,
        pdfName: "NDA-2026-001-beta.pdf",
        completedAt: null,
        hasSubmission: false,
        sendStartedAt: null,
        signers: [],
        signature: { ready: false, reason: "The layout has 0 signature boxes; signing needs exactly four (a signature and a date for each side)." },
      },
    );
    assert.ok(document.createdAt instanceof Date);
  });

  test("reads the settings the template has now, so the labels follow later edits", async () => {
    const id = await insert();
    assert.deepEqual((await getDocument(pool!, id))?.templateVariables, {});
    await pool!.query("update documents.templates set variables = $1::jsonb", [JSON.stringify({ B_NOMBRE: { label: "Nombre de la contraparte" } })]);
    assert.deepEqual((await getDocument(pool!, id))?.templateVariables, { B_NOMBRE: { label: "Nombre de la contraparte" } });
  });

  test("reads the mark of an unfinished send", async () => {
    const id = await insert();
    await pool!.query("update documents.documents set send_started_at = $2 where id = $1", [id, new Date("2026-10-11T10:30:00Z")]);
    assert.equal((await getDocument(pool!, id))?.sendStartedAt?.toISOString(), "2026-10-11T10:30:00.000Z");
  });

  test("reads the signature state: readiness from the layout and the PDF, the stored signers, the submission and the completion time", async () => {
    const id = await insert();
    const boxes = ["firma-1", "fecha-1", "firma-2", "fecha-2"].map((name) => ({ id: name, page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.04 }));
    await pool!.query("update documents.documents set signature_fields = $2::jsonb where id = $1", [id, JSON.stringify({ pages: 1, fields: boxes })]);
    assert.deepEqual((await getDocument(pool!, id))?.signature, { ready: true });
    await pool!.query("update documents.documents set pdf_path = null where id = $1", [id]);
    assert.deepEqual((await getDocument(pool!, id))?.signature, { ready: false, reason: "This document has no PDF." });

    const links = [
      { role: "Acme", name: "Ana", email: "ana@acme.test", link: "https://sign.example.test/s/a", status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { role: "Bad", name: "X", email: "x@y.test", link: "javascript:alert(1)" },
      "junk",
    ];
    await pool!.query("update documents.documents set status = 'completed', docuseal_submission_id = 77, completed_at = '2026-10-12T11:00:00Z', signing_links = $2::jsonb where id = $1", [id, JSON.stringify(links)]);
    const document = await getDocument(pool!, id);
    assert.deepEqual([document?.hasSubmission, document?.completedAt?.toISOString(), document?.signers], [true, "2026-10-12T11:00:00.000Z", [links[0]]]);
  });

  test("returns null for an unknown id", async () => {
    assert.equal(await getDocument(pool!, 999999), null);
    assert.equal(await getDocumentPdfPath(pool!, 999999), null);
  });

  test("copes with a row that has no layout or data (a document from before this task)", async () => {
    const id = await insert();
    await pool!.query("update documents.documents set data = '{}'::jsonb, signature_fields = null, pdf_path = null where id = $1", [id]);
    const document = await getDocument(pool!, id);
    assert.deepEqual([document?.pages, document?.values, document?.profile, document?.hasPdf], [null, {}, {}, false]);
    assert.equal(await getDocumentPdfPath(pool!, id), null);
  });

  test("one rule says a document has a PDF, for the detail page and for the download: a blank path is none", async () => {
    const id = await insert();
    for (const blank of ["", "   "]) {
      await pool!.query("update documents.documents set pdf_path = $2 where id = $1", [id, blank]);
      assert.equal((await getDocument(pool!, id))?.hasPdf, false, JSON.stringify(blank));
      assert.equal(await getDocumentPdfPath(pool!, id), null, JSON.stringify(blank));
    }
    await pool!.query("update documents.documents set pdf_path = 'a.pdf' where id = $1", [id]);
    assert.deepEqual([(await getDocument(pool!, id))?.hasPdf, await getDocumentPdfPath(pool!, id)], [true, "a.pdf"]);
  });

  test("hands out the stored path", async () => {
    const id = await insert({ pdfPath: "NDA-2026-001-beta.pdf" });
    assert.equal(await getDocumentPdfPath(pool!, id), "NDA-2026-001-beta.pdf");
  });

  test("refuses a second document with the same reference", async () => {
    await insert();
    const { rows } = await pool!.query("select id from documents.templates limit 1");
    const again = insertGeneratedDocument(pool!, { ref: "NDA-2026-001", templateId: Number(rows[0].id), templateBodySnapshot: "x", title: "t", counterpartyName: "c", data: { values: {}, profile: {} }, pdfPath: "x.pdf", signatureFields: { pages: 1, fields: [] } });
    await assert.rejects(again, { code: "23505" });
  });
});
