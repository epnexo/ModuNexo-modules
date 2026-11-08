import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileMeta, StoredFile } from "@modunexo/sdk";
import { downloadPdf, wantsInline } from "../web/pdf-route.ts";
import type { Queryable } from "../web/queries.ts";
import { printed } from "./helpers/printed.ts";

/** A database that answers with one document's stored name and file id (or no row), and records the queries. */
function stub(row: { pdf_path: string | null; pdf_file_id: string | null } | undefined) {
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const db: Queryable = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: row === undefined ? [] : [row] };
    },
  };
  return { db, queries };
}

const BYTES = new TextEncoder().encode("%PDF-1.7 hello");
const META: FileMeta = { id: "f1", name: "NDA-2026-001-beta.pdf", contentType: "application/pdf", size: BYTES.length, sha256: "x", ref: "document:NDA-2026-001", createdAt: "2026-11-08T00:00:00Z" };
const file = (): StoredFile => ({ meta: META, stream: new Response(BYTES).body! });
/** A file store with the given ids, recording what was asked for. */
function store(known: string[]) {
  const asked: string[][] = [];
  return { asked, getFile: async (moduleId: string, id: string) => (asked.push([moduleId, id]), known.includes(id) ? file() : null) };
}
const GOOD = { pdf_path: "NDA-2026-001-beta.pdf", pdf_file_id: "f1" };

describe("downloadPdf", () => {
  it("streams the stored file as a PDF attachment from the module's own files", async () => {
    const { db } = stub(GOOD);
    const files = store(["f1"]);
    const response = await downloadPdf(db, "7", { getFile: files.getFile });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="NDA-2026-001-beta.pdf"');
    assert.equal(response.headers.get("content-length"), String(BYTES.length));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "%PDF-1.7 hello");
    assert.deepEqual(files.asked, [["documents", "f1"]], "asks the file store of this module only, by the id kept on the row");
  });

  it("answers 404 for an id that is not a plain positive number, without querying", async () => {
    const { db, queries } = stub(GOOD);
    for (const id of ["0", "-1", "1.5", "abc", "1e3", "", " 7", "7 ", "007x", "99999999999999999999"]) {
      assert.equal((await downloadPdf(db, id, { getFile: store(["f1"]).getFile })).status, 404, JSON.stringify(id));
    }
    assert.equal(queries.length, 0);
  });

  it("answers 404 for an unknown document, a document without a PDF and a document from before the file store", async () => {
    for (const row of [undefined, { pdf_path: null, pdf_file_id: null }, { pdf_path: "a.pdf", pdf_file_id: null }, { pdf_path: "  ", pdf_file_id: "f1" }, { pdf_path: "a.pdf", pdf_file_id: "" }]) {
      const files = store(["f1"]);
      assert.equal((await downloadPdf(stub(row).db, "7", { getFile: files.getFile })).status, 404, JSON.stringify(row));
      assert.deepEqual(files.asked, [], "the file store is not asked when the row names no file");
    }
  });

  it("answers 404 when the file store no longer has the file", async () => {
    assert.equal((await downloadPdf(stub(GOOD).db, "7", { getFile: store([]).getFile })).status, 404);
  });

  it("keeps the file name safe in the header whatever the database holds", async () => {
    const response = await downloadPdf(stub({ pdf_path: 'x"; filename="evil.exe\r\nSet-Cookie: a=b.pdf', pdf_file_id: "f1" }).db, "7", { getFile: store(["f1"]).getFile });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /^attachment; filename="[A-Za-z0-9._-]+"$/);
  });

  it("answers 500 with a plain message, and logs only the error code, when the database fails", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const db: Queryable = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db/x"), { code: "ECONNREFUSED" })) };
    const response = await downloadPdf(db, "7", { getFile: store(["f1"]).getFile });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /hunter2|postgres/);
    assert.doesNotMatch(printed(logged), /hunter2/);
    assert.match(String(logged[0]![1]), /ECONNREFUSED/);
  });

  it("answers 500 with a plain message when the file store fails, and does not repeat its error", async (t) => {
    t.mock.method(console, "error", () => {});
    const response = await downloadPdf(stub(GOOD).db, "7", { getFile: async () => Promise.reject(new Error("disk /srv/secret/path is gone")) });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /secret/);
  });
});

describe("downloadPdf: the inline variant", () => {
  it("serves the same file with an inline disposition, the same name and the same private headers", async () => {
    const response = await downloadPdf(stub(GOOD).db, "7", { inline: true, getFile: store(["f1"]).getFile });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="NDA-2026-001-beta.pdf"');
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "%PDF-1.7 hello");
  });

  it("answers the same 404 as the download for a bad id, an unknown document and a missing file", async () => {
    for (const [id, row] of [["abc", GOOD], ["7", undefined], ["7", { pdf_path: "a.pdf", pdf_file_id: null }]] as const) {
      assert.equal((await downloadPdf(stub(row).db, id, { inline: true, getFile: store([]).getFile })).status, 404, `${id} ${JSON.stringify(row)}`);
    }
  });
});

describe("wantsInline", () => {
  it("is true only for inline=1 in the query", () => {
    assert.equal(wantsInline("http://127.0.0.1:3010/documents/7/pdf?inline=1"), true);
    assert.equal(wantsInline("http://127.0.0.1:3010/documents/7/pdf?x=2&inline=1"), true);
    for (const url of ["http://h/documents/7/pdf", "http://h/documents/7/pdf?inline=0", "http://h/documents/7/pdf?inline=true", "http://h/documents/7/pdf?inline=", "http://h/documents/7/pdf?Inline=1", "not a url"]) assert.equal(wantsInline(url), false, url);
  });
});
