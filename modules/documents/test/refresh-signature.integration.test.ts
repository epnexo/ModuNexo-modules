import assert from "node:assert/strict";
import { printed } from "./helpers/printed.ts";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import type pg from "pg";
import type { DocusealClient, DocusealError, DocusealResult, SubmissionSigner } from "../src/docuseal-client.ts";
import { insertGeneratedDocument } from "../src/document-store.ts";
import { refreshSignature } from "../src/refresh-signature.ts";
import { createTemplate } from "../src/template-store.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_refresh"));
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
});

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(t);
  });

const LINKS = [
  { role: "Acme", name: "Ana", email: "ana@acme.test", link: "https://sign.example.test/s/AAA-secret-link" },
  { role: "Beta", name: "Ben", email: "ben@beta.test", link: "https://sign.example.test/s/BBB-secret-link" },
];

let counter = 0;

/** A document that was sent: status `sent`, submission 77, two stored signers. */
async function sentDocument(status = "sent"): Promise<number> {
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: `nda-${Math.random().toString(36).slice(2, 8)}`, kind: "nda", refPrefix: "NDA", bodyHtml: "<p>x</p>", counterpartyMarker: null });
  assert.ok(created.ok);
  const id = await insertGeneratedDocument(pool!, {
    ref: `NDA-2026-${String(++counter).padStart(3, "0")}`,
    templateId: created.ok ? created.id : 0,
    templateBodySnapshot: "<p>x</p>",
    title: "Mutual NDA — Beta",
    counterpartyName: "Beta",
    data: { values: {}, profile: {} },
    pdfPath: "NDA-2026-001-beta.pdf",
    pdfFileId: "file-1",
    signatureFields: { pages: 3, fields: [] },
  });
  await pool!.query("update documents.documents set status = $2, docuseal_template_id = 42, docuseal_submission_id = 77, signing_links = $3::jsonb where id = $1", [id, status, JSON.stringify(LINKS)]);
  return id;
}

const row = async (id: number) => (await pool!.query("select status, completed_at, signing_links, updated_at from documents.documents where id = $1", [id])).rows[0]!;

function docuseal(answer: DocusealResult<{ status: string; completedAt: string | null; signers: SubmissionSigner[] }>) {
  const asked: number[] = [];
  const client = { getSubmission: async (id: number) => (asked.push(id), answer) } as unknown as DocusealClient;
  return { asked, client };
}
const reports = (status: string, signers: SubmissionSigner[] = [], completedAt: string | null = null) => docuseal({ ok: true, value: { status, completedAt, signers } });

const NOW = new Date("2026-10-13T08:00:00.000Z");

describe("refreshSignature", () => {
  test("keeps a pending submission as sent and stores each signer's status and time", async () => {
    const id = await sentDocument();
    const { asked, client } = reports("pending", [
      { role: "Acme", email: "ana@acme.test", status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { role: "Beta", email: "ben@beta.test", status: "opened", at: "2026-10-12T09:30:00.000Z" },
    ]);
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client, now: () => NOW }, id), { ok: true, outcome: "unchanged", status: "sent", signersChanged: true });
    assert.deepEqual(asked, [77]);
    const stored = await row(id);
    assert.equal(stored.status, "sent");
    assert.equal(stored.completed_at, null);
    assert.deepEqual(stored.signing_links, [
      { ...LINKS[0], status: "completed", at: "2026-10-12T10:00:00.000Z" },
      { ...LINKS[1], status: "opened", at: "2026-10-12T09:30:00.000Z" },
    ]);
  });

  test("says whether signer progress changed even when the document status did not", async () => {
    const id = await sentDocument();
    const signers = [{ role: "Acme", email: "ana@acme.test", status: "opened", at: "2026-10-12T09:00:00.000Z" }];
    const first = await refreshSignature({ db: pool!, docuseal: reports("pending", signers).client }, id);
    assert.deepEqual(first, { ok: true, outcome: "unchanged", status: "sent", signersChanged: true });
    const again = await refreshSignature({ db: pool!, docuseal: reports("pending", signers).client }, id);
    assert.deepEqual(again, { ok: true, outcome: "unchanged", status: "sent", signersChanged: false });
    const progressed = await refreshSignature({ db: pool!, docuseal: reports("pending", [{ ...signers[0]!, status: "completed", at: "2026-10-12T10:00:00.000Z" }]).client }, id);
    assert.deepEqual(progressed, { ok: true, outcome: "unchanged", status: "sent", signersChanged: true });
  });

  test("merges into the stored signers: a malformed entry and a key this version does not know survive the refresh", async () => {
    const id = await sentDocument();
    const stored = [{ ...LINKS[0], note: "keep me", nested: { a: [1] } }, { role: "Broken" }, null, LINKS[1]];
    await pool!.query("update documents.documents set signing_links = $2::jsonb where id = $1", [id, JSON.stringify(stored)]);
    const { client } = reports("pending", [{ role: "Beta", email: "ben@beta.test", status: "opened", at: "2026-10-12T09:30:00.000Z" }]);
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client }, id), { ok: true, outcome: "unchanged", status: "sent", signersChanged: true });
    assert.deepEqual((await row(id)).signing_links, [stored[0], stored[1], null, { ...LINKS[1], status: "opened", at: "2026-10-12T09:30:00.000Z" }]);
  });

  test("leaves signing links that are not a list exactly as they are", async () => {
    const id = await sentDocument();
    await pool!.query("update documents.documents set signing_links = '{\"odd\": true}'::jsonb where id = $1", [id]);
    const { client } = reports("completed", [{ role: "Acme", email: null, status: "completed", at: "2026-10-12T10:00:00.000Z" }], "2026-10-12T11:00:00.000Z");
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client }, id), { ok: true, outcome: "updated", status: "completed", signersChanged: false });
    assert.deepEqual((await row(id)).signing_links, { odd: true });
  });

  test("completes the document with the time DocuSeal gives, else the latest signer's, else the time of the refresh", async () => {
    const withTime = await sentDocument();
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: reports("completed", [], "2026-10-12T11:00:00.000Z").client, now: () => NOW }, withTime), { ok: true, outcome: "updated", status: "completed", signersChanged: false });
    assert.equal((await row(withTime)).status, "completed");
    assert.equal((await row(withTime)).completed_at.toISOString(), "2026-10-12T11:00:00.000Z");

    const fromSigners = await sentDocument();
    await refreshSignature({ db: pool!, docuseal: reports("completed", [{ role: "Acme", email: null, status: "completed", at: "2026-10-12T10:30:00.000Z" }]).client, now: () => NOW }, fromSigners);
    assert.equal((await row(fromSigners)).completed_at.toISOString(), "2026-10-12T10:30:00.000Z");

    const fromClock = await sentDocument();
    await refreshSignature({ db: pool!, docuseal: reports("completed").client, now: () => NOW }, fromClock);
    assert.equal((await row(fromClock)).completed_at.toISOString(), NOW.toISOString());
  });

  test("records a declined and an expired submission", async () => {
    for (const status of ["declined", "expired"] as const) {
      const id = await sentDocument();
      assert.deepEqual(await refreshSignature({ db: pool!, docuseal: reports(status).client }, id), { ok: true, outcome: "updated", status, signersChanged: false });
      const stored = await row(id);
      assert.deepEqual([stored.status, stored.completed_at], [status, null]);
    }
  });

  test("changes nothing for a status it does not know and returns it, made safe, for a visible note", async () => {
    const id = await sentDocument();
    const before = await row(id);
    const result = await refreshSignature({ db: pool!, docuseal: reports("<b>archived</b>", [{ role: "Acme", email: null, status: "completed", at: null }]).client }, id);
    assert.deepEqual(result, { ok: true, outcome: "unknown", reported: "barchivedb" });
    assert.deepEqual(await row(id), before);
  });

  test("reports a DocuSeal failure with its error, logs only its code, and changes nothing", async (t) => {
    const logged: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
    const id = await sentDocument();
    const before = await row(id);
    const error: DocusealError = { kind: "unauthorized", status: 401 };
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: docuseal({ ok: false, error }).client }, id), { ok: false, kind: "docuseal", error });
    assert.deepEqual(await row(id), before);
    assert.match(printed(logged), /docuseal-unauthorized-401/);
    assert.doesNotMatch(printed(logged), /ana@acme|secret-link/);
  });

  test("says not configured, not found, and not sent for a document that is not waiting for signatures", async () => {
    const id = await sentDocument();
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: null }, id), { ok: false, kind: "not-configured" });
    const { asked, client } = reports("completed");
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client }, 999999), { ok: false, kind: "not-found" });
    for (const status of ["generated", "completed", "declined", "expired"]) {
      await pool!.query("update documents.documents set status = $2 where id = $1", [id, status]);
      assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client }, id), { ok: false, kind: "not-sent", status });
    }
    await pool!.query("update documents.documents set status = 'sent', docuseal_submission_id = null where id = $1", [id]);
    assert.equal((await refreshSignature({ db: pool!, docuseal: client }, id)).ok, false);
    assert.deepEqual(asked, []);
  });

  test("writes nothing when the document changed while DocuSeal was being asked", async () => {
    const id = await sentDocument();
    const client = {
      getSubmission: async () => {
        await pool!.query("update documents.documents set status = 'declined' where id = $1", [id]);
        return { ok: true, value: { status: "completed", completedAt: null, signers: [] } };
      },
    } as unknown as DocusealClient;
    assert.deepEqual(await refreshSignature({ db: pool!, docuseal: client }, id), { ok: false, kind: "stale" });
    assert.equal((await row(id)).status, "declined");
  });
});
