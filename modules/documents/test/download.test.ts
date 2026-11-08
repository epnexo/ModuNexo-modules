import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { type FileHandle, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { downloadPdf, wantsInline } from "../web/pdf-route.ts";
import type { Queryable } from "../web/queries.ts";

let root: string;
let dir: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "documents-download-"));
  dir = join(root, "documents");
  await mkdir(join(dir, "sub"), { recursive: true });
  await writeFile(join(dir, "NDA-2026-001-beta.pdf"), "%PDF-1.7 hello");
  await writeFile(join(root, "secret.pdf"), "TOP SECRET");
  await symlink(join(root, "secret.pdf"), join(dir, "link.pdf"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A database that answers with one stored path (or no row), and records the queries. */
function stub(pdfPath: string | null | undefined) {
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const db: Queryable = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: pdfPath === undefined ? [] : [{ pdf_path: pdfPath }] };
    },
  };
  return { db, queries };
}

describe("downloadPdf", () => {
  it("streams the stored file as a PDF attachment", async () => {
    const { db, queries } = stub("NDA-2026-001-beta.pdf");
    const response = await downloadPdf(db, dir, "7");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="NDA-2026-001-beta.pdf"');
    assert.equal(response.headers.get("content-length"), String("%PDF-1.7 hello".length));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(await response.text(), "%PDF-1.7 hello");
    assert.deepEqual(queries[0]!.values, [7], "the id is a parameter");
  });

  it("answers 404 for an id that is not a plain positive number, without querying", async () => {
    for (const id of ["abc", "0", "-1", "1x", "1 or 1=1", "", "007", "../1", "99999999999999999999"]) {
      const { db, queries } = stub("NDA-2026-001-beta.pdf");
      assert.equal((await downloadPdf(db, dir, id)).status, 404, id);
      assert.equal(queries.length, 0, id);
    }
  });

  it("answers 404 for an unknown document and for a document without a file", async () => {
    assert.equal((await downloadPdf(stub(undefined).db, dir, "7")).status, 404);
    assert.equal((await downloadPdf(stub(null).db, dir, "7")).status, 404);
  });

  it("answers 404 when the file is gone or is not a regular file", async () => {
    assert.equal((await downloadPdf(stub("missing.pdf").db, dir, "7")).status, 404);
    assert.equal((await downloadPdf(stub("sub").db, dir, "7")).status, 404);
  });

  it("refuses a stored path that leaves the folder, however hostile, even when the file exists", async () => {
    for (const hostile of ["../secret.pdf", "sub/../../secret.pdf", join(root, "secret.pdf"), "..", "link.pdf", "\0../secret.pdf", "../documents-evil/x.pdf"]) {
      const response = await downloadPdf(stub(hostile).db, dir, "7");
      assert.equal(response.status, 404, JSON.stringify(hostile));
      assert.doesNotMatch(await response.text(), /TOP SECRET/);
    }
  });

  it("answers 404 for a symbolic link that dangles, whether it points out of the folder or not", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    await symlink(join(root, "nowhere.pdf"), join(dir, "dangling.pdf"));
    assert.equal((await downloadPdf(stub("dangling.pdf").db, dir, "7")).status, 404);
    assert.equal(logged.length, 0, "a missing target is not a server error");
  });

  it("answers 404 for a stored path that is blank", async () => {
    assert.equal((await downloadPdf(stub("").db, dir, "7")).status, 404);
  });

  it("opens the file before it builds the response, so a failure can still answer with a status", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const refusing = (code: string) => (async () => Promise.reject(Object.assign(new Error(`${code} /srv/secret/path.pdf`), { code }))) as unknown as typeof open;
    const denied = await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { open: refusing("EACCES") });
    assert.equal(denied.status, 500);
    assert.doesNotMatch(await denied.text(), /secret|EACCES/);
    assert.equal((await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { open: refusing("EMFILE") })).status, 500);
    assert.match(printed(logged), /EACCES/);
    assert.doesNotMatch(printed(logged), /secret/, "the code only, never the path");
    assert.equal((await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { open: refusing("ENOENT") })).status, 404, "a file that vanished after the check is a missing file");
  });

  it("closes the file when it is not a regular file", async () => {
    let closed = false;
    const fake = { stat: async () => ({ isFile: () => false, size: 0 }), close: async () => void (closed = true) } as unknown as FileHandle;
    assert.equal((await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { open: (async () => fake) as unknown as typeof open })).status, 404);
    assert.equal(closed, true);
  });

  it("logs an error that happens while the file is streamed", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from("%PDF-1.7");
        throw Object.assign(new Error("read failed /srv/secret/path.pdf"), { code: "EIO" });
      })(),
    );
    const fake = { stat: async () => ({ isFile: () => true, size: 20 }), createReadStream: () => broken, close: async () => {} } as unknown as FileHandle;
    const response = await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { open: (async () => fake) as unknown as typeof open });
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer());
    assert.match(printed(logged), /EIO/);
    assert.doesNotMatch(printed(logged), /secret/);
  });

  it("keeps the file name safe in the header whatever the database holds", async () => {
    await writeFile(join(dir, 'we"ird name.pdf'), "x");
    const response = await downloadPdf(stub('we"ird name.pdf').db, dir, "7");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="we_ird_name.pdf"');
    await response.arrayBuffer();
  });

  it("answers 500 with a plain message, and logs only the error code, when the database fails", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const db: Queryable = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db/x"), { code: "ECONNREFUSED" })) };
    const response = await downloadPdf(db, dir, "7");
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /hunter2|postgres/);
    assert.doesNotMatch(printed(logged), /hunter2/);
    assert.match(String(logged[0]![1]), /ECONNREFUSED/);
  });
});

describe("downloadPdf: the inline variant", () => {
  const inline = { inline: true };

  it("streams the same file with an inline disposition and the same name, and the same private headers", async () => {
    const { db, queries } = stub("NDA-2026-001-beta.pdf");
    const response = await downloadPdf(db, dir, "7", inline);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="NDA-2026-001-beta.pdf"');
    assert.equal(response.headers.get("content-length"), String("%PDF-1.7 hello".length));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "%PDF-1.7 hello");
    assert.deepEqual(queries[0]!.values, [7]);
  });

  it("keeps the attachment disposition unless inline is asked for", async () => {
    for (const options of [{}, { inline: false }]) {
      const response = await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", options);
      assert.match(response.headers.get("content-disposition")!, /^attachment; /);
      await response.arrayBuffer();
    }
  });

  it("answers the same 404 as the download for a bad id, an unknown document, no file, a missing file and a blank path", async () => {
    for (const id of ["abc", "0", "007", "../1", ""]) assert.equal((await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, id, inline)).status, 404, id);
    assert.equal((await downloadPdf(stub(undefined).db, dir, "7", inline)).status, 404);
    assert.equal((await downloadPdf(stub(null).db, dir, "7", inline)).status, 404);
    assert.equal((await downloadPdf(stub("").db, dir, "7", inline)).status, 404);
    assert.equal((await downloadPdf(stub("missing.pdf").db, dir, "7", inline)).status, 404);
    assert.equal((await downloadPdf(stub("sub").db, dir, "7", inline)).status, 404);
  });

  it("refuses a stored path that leaves the folder, however hostile", async () => {
    for (const hostile of ["../secret.pdf", "sub/../../secret.pdf", join(root, "secret.pdf"), "..", "link.pdf", "\0../secret.pdf"]) {
      const response = await downloadPdf(stub(hostile).db, dir, "7", inline);
      assert.equal(response.status, 404, JSON.stringify(hostile));
      assert.doesNotMatch(await response.text(), /TOP SECRET/);
    }
  });

  it("answers 500 in plain text for a file-system failure and for a database failure", async (t) => {
    t.mock.method(console, "error", () => {});
    const refusing = (async () => Promise.reject(Object.assign(new Error("denied /srv/secret"), { code: "EACCES" }))) as unknown as typeof open;
    const denied = await downloadPdf(stub("NDA-2026-001-beta.pdf").db, dir, "7", { inline: true, open: refusing });
    assert.equal(denied.status, 500);
    assert.doesNotMatch(await denied.text(), /secret|EACCES/);
    const db: Queryable = { query: async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })) };
    assert.equal((await downloadPdf(db, dir, "7", inline)).status, 500);
  });

  it("keeps the file name safe in the header", async () => {
    await writeFile(join(dir, 'in"line name.pdf'), "x");
    const response = await downloadPdf(stub('in"line name.pdf').db, dir, "7", inline);
    assert.equal(response.headers.get("content-disposition"), 'inline; filename="in_line_name.pdf"');
    await response.arrayBuffer();
  });
});

describe("wantsInline", () => {
  it("is true only for inline=1 in the query", () => {
    assert.equal(wantsInline("http://127.0.0.1:3010/documents/7/pdf?inline=1"), true);
    assert.equal(wantsInline("http://127.0.0.1:3010/documents/7/pdf?x=2&inline=1"), true);
    for (const url of ["http://h/documents/7/pdf", "http://h/documents/7/pdf?inline=0", "http://h/documents/7/pdf?inline=true", "http://h/documents/7/pdf?inline=", "http://h/documents/7/pdf?Inline=1", "not a url"]) assert.equal(wantsInline(url), false, url);
  });
});
