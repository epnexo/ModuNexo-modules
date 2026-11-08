import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { describe, it } from "node:test";
import { type DocusealClient, createDocusealClient } from "../src/docuseal-client.ts";
import type { Queryable } from "../web/queries.ts";
import { downloadSignedPdf, downloadSignedPdfWith } from "../web/signed-pdf-route.ts";

const BASE = "https://sign.example.test";
const TOKEN = "tok_SECRET_123";

/** A database that answers with one signing row (or none) and records the queries. */
function stub(row: Record<string, unknown> | undefined) {
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const db: Queryable = {
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: row === undefined ? [] : [row] };
    },
  };
  return { db, queries };
}
const completed = (extra: Record<string, unknown> = {}) => ({ id: 7, ref: "NDA-2026-001", status: "completed", counterparty_name: "Beta Ltd", docuseal_submission_id: 77, signing_links: [], ...extra });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** The real client over a fake fetch, so the origin rule is exercised end to end. */
function client(...handlers: Handler[]) {
  const calls: { url: string; token: string | null }[] = [];
  const queue = [...handlers];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), token: new Headers(init.headers).get("x-auth-token") });
    const next = queue.shift();
    if (!next) throw new Error("no answer queued");
    return next(String(input), init);
  }) as typeof fetch;
  return { calls, docuseal: createDocusealClient({ url: BASE, token: TOKEN, fetch: impl, timeoutMs: 200 }) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const pdf = (text = "%PDF-1.7 signed") => new Response(new TextEncoder().encode(text), { status: 200 });
const listing = (...urls: string[]) => json({ documents: urls.map((url) => ({ url })) });

const logs = (t: { mock: { method: (o: object, n: "error", i: (...a: unknown[]) => void) => void } }) => {
  const lines: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void lines.push(args));
  return lines;
};

describe("downloadSignedPdf", () => {
  it("streams the signed PDF of a completed document as an attachment named <REF>-<counterparty>-signed.pdf", async () => {
    const { docuseal, calls } = client(() => listing(`${BASE}/file/abc/NDA.pdf`, `${BASE}/file/def/audit.pdf`), () => pdf());
    const { db, queries } = stub(completed());
    const response = await downloadSignedPdf({ db, docuseal }, "7");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="NDA-2026-001-beta-ltd-signed.pdf"');
    assert.equal(response.headers.get("content-length"), String("%PDF-1.7 signed".length));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), "%PDF-1.7 signed");
    assert.deepEqual(queries[0]!.values, [7], "the id is a parameter");
    assert.deepEqual(
      calls.map((c) => c.url),
      [`${BASE}/api/submissions/77/documents`, `${BASE}/file/abc/NDA.pdf`],
      "only the first document is fetched",
    );
    assert.deepEqual(
      calls.map((c) => c.token),
      [TOKEN, null],
      "the token goes to the API and not to the file",
    );
  });

  it("answers 404 for an id that is not a plain positive number, without querying", async () => {
    for (const id of ["abc", "0", "-1", "1x", "1 or 1=1", "", "007", "../1", "99999999999999999999"]) {
      const { db, queries } = stub(completed());
      assert.equal((await downloadSignedPdf({ db, docuseal: client().docuseal }, id)).status, 404, id);
      assert.equal(queries.length, 0, id);
    }
  });

  it("answers 404 for an unknown document", async () => {
    assert.equal((await downloadSignedPdf({ db: stub(undefined).db, docuseal: client().docuseal }, "7")).status, 404);
  });

  it("answers 409 for a document that is not completed, without calling DocuSeal", async () => {
    for (const status of ["generated", "sent", "declined", "expired", "draft"]) {
      const { docuseal, calls } = client();
      assert.equal((await downloadSignedPdf({ db: stub(completed({ status })).db, docuseal }, "7")).status, 409, status);
      assert.equal(calls.length, 0);
    }
    assert.equal((await downloadSignedPdf({ db: stub(completed({ docuseal_submission_id: null })).db, docuseal: client().docuseal }, "7")).status, 409);
  });

  it("answers 503 when signing is not configured, and logs the code", async (t) => {
    const lines = logs(t);
    const response = await downloadSignedPdf({ db: stub(completed()).db, docuseal: null }, "7");
    assert.equal(response.status, 503);
    assert.match(await response.text(), /DOCUSEAL_URL/);
    assert.match(printed(lines), /docuseal-not-configured/);
  });

  it("answers 504 for a timeout and 502 for every other DocuSeal failure, logging only the code", async (t) => {
    const cases: [string, Handler[], number, RegExp][] = [
      ["timeout", [(_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(init.signal?.reason)))], 504, /docuseal-unreachable-timeout/],
      ["network", [() => Promise.reject(new Error(`down ${TOKEN}`))], 502, /docuseal-unreachable-network/],
      ["token refused", [() => json({}, 401)], 502, /docuseal-unauthorized-401/],
      ["submission gone", [() => json({}, 404)], 502, /docuseal-not-found/],
      ["server error", [() => json({}, 500)], 502, /docuseal-server-error-500/],
      ["odd listing", [() => json({ documents: "x" })], 502, /docuseal-unexpected/],
      ["file fetch fails", [() => listing(`${BASE}/f`), () => json({}, 500)], 502, /docuseal-server-error-500/],
      ["not a pdf", [() => listing(`${BASE}/f`), () => new Response("<html>", { status: 200 })], 502, /docuseal-unexpected/],
    ];
    for (const [name, handlers, status, code] of cases) {
      const lines = logs(t);
      const response = await downloadSignedPdf({ db: stub(completed()).db, docuseal: client(...handlers).docuseal }, "7");
      assert.equal(response.status, status, name);
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(`${TOKEN}|sign\\.example`), name);
      assert.match(printed(lines), code, name);
      assert.doesNotMatch(printed(lines), new RegExp(TOKEN), name);
    }
  });

  it("labels a DocuSeal client that fails unexpectedly as a DocuSeal failure (502), apart from a database failure (500), in status and log", async (t) => {
    for (const call of ["listDocuments", "downloadDocument"] as const) {
      const lines = logs(t);
      const boom = () => Promise.reject(Object.assign(new TypeError(`unexpected ${TOKEN} hunter2`), { code: "ERR_BOOM" }));
      const fake = {
        listDocuments: call === "listDocuments" ? boom : async () => ({ ok: true as const, value: [{ url: `${BASE}/f`, name: null }] }),
        downloadDocument: boom,
      } as unknown as DocusealClient;
      const response = await downloadSignedPdf({ db: stub(completed()).db, docuseal: fake }, "7");
      assert.equal(response.status, 502, call);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.doesNotMatch(await response.text(), /hunter2|ERR_BOOM|unexpected/);
      assert.match(printed(lines), /DocuSeal/i, call);
      assert.match(printed(lines), /ERR_BOOM/, call);
      assert.doesNotMatch(printed(lines), /database|load the document|hunter2/i, call);
    }
  });

  it("refuses a document URL on another origin with a 502, without fetching it", async (t) => {
    const lines = logs(t);
    const { docuseal, calls } = client(() => listing("https://evil.test/steal.pdf"));
    assert.equal((await downloadSignedPdf({ db: stub(completed()).db, docuseal }, "7")).status, 502);
    assert.equal(calls.length, 1);
    assert.match(printed(lines), /docuseal-refused-url/);
  });

  it("answers 502 when DocuSeal lists no document", async (t) => {
    const lines = logs(t);
    assert.equal((await downloadSignedPdf({ db: stub(completed()).db, docuseal: client(() => listing()).docuseal }, "7")).status, 502);
    assert.match(printed(lines), /docuseal-no-documents/);
  });

  it("answers 500 with a plain message, logging only the error code, when the database fails", async (t) => {
    const lines = logs(t);
    const db: Queryable = { query: async () => Promise.reject(Object.assign(new Error("connect failed postgres://u:hunter2@db/x"), { code: "ECONNREFUSED" })) };
    const response = await downloadSignedPdf({ db, docuseal: client().docuseal }, "7");
    assert.equal(response.status, 500);
    assert.match(printed(lines), /database/i, "the log says it was the database");
    assert.doesNotMatch(printed(lines), /docuseal/i, "and does not blame DocuSeal");
    assert.doesNotMatch(await response.text(), /hunter2|postgres/);
    assert.doesNotMatch(printed(lines), /hunter2/);
    assert.match(printed(lines), /ECONNREFUSED/);
  });

  it("answers a failure while setting up (the pool, the client from the environment) the same plain-text way, logging only the code", async (t) => {
    const lines = logs(t);
    const response = await downloadSignedPdfWith(() => {
      throw Object.assign(new Error("DATABASE_URL postgres://u:hunter2@db/x is not valid"), { code: "ERR_SETUP" });
    }, "7");
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.doesNotMatch(await response.text(), /hunter2|postgres|DATABASE_URL/);
    assert.match(printed(lines), /ERR_SETUP/);
    assert.doesNotMatch(printed(lines), /hunter2/);
  });

  it("builds its dependencies only for a valid id, and passes them to the download", async () => {
    let built = 0;
    const deps = () => ((built += 1), { db: stub(completed({ status: "sent" })).db, docuseal: null });
    assert.equal((await downloadSignedPdfWith(deps, "abc")).status, 404);
    assert.equal(built, 0);
    assert.equal((await downloadSignedPdfWith(deps, "7")).status, 409);
    assert.equal(built, 1);
  });

  it("keeps the file name safe in the header whatever the database holds", async () => {
    const { docuseal } = client(() => listing(`${BASE}/f`), () => pdf());
    const response = await downloadSignedPdf({ db: stub(completed({ ref: 'N"DA\r\nX: y', counterparty_name: "../Évil <b>" })).db, docuseal }, "7");
    assert.match(response.headers.get("content-disposition")!, /^attachment; filename="[A-Za-z0-9._-]+-signed\.pdf"$/);
    await response.arrayBuffer();
  });

  it("does not call DocuSeal's client with anything but the stored submission id", async () => {
    const asked: number[] = [];
    const fake = { listDocuments: async (id: number) => (asked.push(id), { ok: true as const, value: [] }) } as unknown as DocusealClient;
    await downloadSignedPdf({ db: stub(completed({ docuseal_submission_id: "77" })).db, docuseal: fake }, "7");
    assert.deepEqual(asked, [77]);
  });
});
