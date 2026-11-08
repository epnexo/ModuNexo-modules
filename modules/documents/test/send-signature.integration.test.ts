import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import type pg from "pg";
import type { DocusealClient, DocusealError, DocusealResult } from "../src/docuseal-client.ts";
import { insertGeneratedDocument } from "../src/document-store.ts";
import { SEND_MAX_DURATION_MS, clearUnfinishedSend, sendForSignature } from "../src/send-signature.ts";
import { createTemplate } from "../src/template-store.ts";
import type { Transactional } from "../src/transaction.ts";
import { printed } from "./helpers/printed.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_signature"));
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

const BOXES = [
  { id: "firma-1", page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
  { id: "fecha-1", page: 2, x: 0.1, y: 0.86, w: 0.3, h: 0.03 },
  { id: "firma-2", page: 2, x: 0.55, y: 0.8, w: 0.3, h: 0.05 },
  { id: "fecha-2", page: 2, x: 0.55, y: 0.86, w: 0.3, h: 0.03 },
];

async function insert(extra: { fields?: unknown[]; pdfPath?: string | null; ref?: string; profile?: Record<string, string>; counterpartyName?: string } = {}): Promise<number> {
  const created = await createTemplate(pool!, { name: "Mutual NDA", slug: `nda-${Math.random().toString(36).slice(2, 8)}`, kind: "nda", refPrefix: "NDA", bodyHtml: "<p>x</p>", counterpartyMarker: null });
  assert.ok(created.ok);
  const id = await insertGeneratedDocument(pool!, {
    ref: extra.ref ?? "NDA-2026-001",
    templateId: created.ok ? created.id : 0,
    templateBodySnapshot: "<p>x</p>",
    title: "Mutual NDA — Beta",
    counterpartyName: extra.counterpartyName ?? "Beta",
    data: { values: { B_NOMBRE: "Beta" }, profile: extra.profile ?? { A_CORTO: "Acme", A_NOMBRE: "Acme Corp" } },
    pdfPath: "NDA-2026-001-beta.pdf",
    pdfFileId: "file-1",
    signatureFields: { pages: 3, fields: (extra.fields ?? BOXES) as never },
  });
  if (extra.pdfPath !== undefined) await pool!.query("update documents.documents set pdf_path = $2 where id = $1", [id, extra.pdfPath]);
  return id;
}

/** Make the mark look `ageMs` old by the database clock, without waiting. */
const markAged = (id: number, ageMs: number) => pool!.query("update documents.documents set send_started_at = date_trunc('milliseconds', clock_timestamp()) - make_interval(secs => $2::float8 / 1000) where id = $1", [id, ageMs]);

const row = async (id: number) => (await pool!.query("select status, docuseal_template_id, docuseal_submission_id, signing_links, completed_at, send_started_at from documents.documents where id = $1", [id])).rows[0]!;

const RAW = { ownerName: "Ana Gómez", ownerEmail: "ana@acme.test", counterpartyName: "Ben Ruiz", counterpartyEmail: "ben@beta.test", order: "preserved" };
const LINK_A = "https://sign.example.test/s/AAA-secret-link";
const LINK_B = "https://sign.example.test/s/BBB-secret-link";

type Log = [string, ...unknown[]][];
const ok = <T,>(value: T): Promise<DocusealResult<T>> => Promise.resolve({ ok: true, value });
const failed = (error: DocusealError): Promise<DocusealResult<never>> => Promise.resolve({ ok: false, error });

/** A DocuSeal that answers with the shapes the skill reads and records each call. */
function fakeDocuseal(overrides: Partial<DocusealClient> = {}) {
  const log: Log = [];
  const client: DocusealClient = {
    findTemplateByName: (name) => (log.push(["find", name]), ok({ id: 42 })),
    getTemplate: (id) => (log.push(["read", id]), ok({ attachmentUuid: "att-1", submitterUuids: ["sub-a", "sub-b"] })),
    updateTemplate: (id, update) => (log.push(["fields", id, update]), ok(null)),
    createSubmission: (request) =>
      (log.push(["submission", request]),
      ok({
        submissionId: 77,
        submitters: [
          { role: request.submitters[0]!.role, link: LINK_A },
          { role: request.submitters[1]!.role, link: LINK_B },
        ],
      })),
    getSubmission: () => failed({ kind: "unexpected", what: "not used" }),
    listDocuments: () => failed({ kind: "unexpected", what: "not used" }),
    downloadDocument: () => failed({ kind: "unexpected", what: "not used" }),
    ...overrides,
  };
  return { log, client };
}

function uuids() {
  let n = 0;
  return () => `uuid-${++n}`;
}

const names = (log: Log) => log.map((entry) => entry[0]);

/** Capture what the service writes to the console. */
function captureConsole(t: TestContext) {
  const lines: unknown[][] = [];
  for (const name of ["error", "warn", "log"] as const) t.mock.method(console, name, (...args: unknown[]) => void lines.push(args));
  return lines;
}

describe("sendForSignature", () => {
  test("finds the template by the PDF name, places the four boxes, creates the submission and stores everything", async () => {
    const id = await insert();
    const { log, client } = fakeDocuseal();
    const result = await sendForSignature({ db: pool!, docuseal: client, newUuid: uuids() }, id, RAW);
    assert.deepEqual(result, { ok: true, submissionId: 77 });
    assert.deepEqual(names(log), ["find", "read", "fields", "submission"]);
    assert.deepEqual(log[0], ["find", "NDA-2026-001-beta"]);
    assert.deepEqual(log[1], ["read", 42]);

    const [, templateId, update] = log[2] as [string, number, { submitters: unknown[]; fields: { name: string; type: string; submitter_uuid: string; areas: unknown[] }[] }];
    assert.equal(templateId, 42);
    assert.deepEqual(update.submitters, [
      { name: "Acme", uuid: "sub-a" },
      { name: "Beta", uuid: "sub-b" },
    ]);
    assert.deepEqual(
      update.fields.map((f) => [f.name, f.type, f.submitter_uuid]),
      [
        ["Firma Acme", "signature", "sub-a"],
        ["Fecha Acme", "date", "sub-a"],
        ["Firma Beta", "signature", "sub-b"],
        ["Fecha Beta", "date", "sub-b"],
      ],
    );
    assert.deepEqual(update.fields[2]!.areas, [{ x: 0.55, y: 0.8, w: 0.3, h: 0.05, page: 2, attachment_uuid: "att-1" }]);
    assert.deepEqual(log[3], [
      "submission",
      {
        templateId: 42,
        order: "preserved",
        submitters: [
          { role: "Acme", name: "Ana Gómez", email: "ana@acme.test" },
          { role: "Beta", name: "Ben Ruiz", email: "ben@beta.test" },
        ],
      },
    ]);

    const stored = await row(id);
    assert.deepEqual([stored.status, Number(stored.docuseal_template_id), Number(stored.docuseal_submission_id)], ["sent", 42, 77]);
    assert.deepEqual(stored.signing_links, [
      { role: "Acme", name: "Ana Gómez", email: "ana@acme.test", link: LINK_A },
      { role: "Beta", name: "Ben Ruiz", email: "ben@beta.test", link: LINK_B },
    ]);
  });

  test("derives the roles from the snapshot: the full name without a short one, Owner with neither, and two distinct roles when the names are equal", async () => {
    const cases: [Record<string, string>, string, [string, string]][] = [
      [{ A_NOMBRE: "Acme Corp" }, "Beta", ["Acme Corp", "Beta"]],
      [{}, "Beta", ["Owner", "Beta"]],
      [{ A_CORTO: "Beta" }, "Beta", ["Beta", "Beta (2)"]],
      [{ A_CORTO: "beta" }, "BETA", ["beta", "BETA (2)"]],
    ];
    for (const [index, [profile, counterpartyName, [owner, counterparty]]] of cases.entries()) {
      const id = await insert({ profile, counterpartyName, ref: `NDA-2026-3${String(index).padStart(2, "0")}` });
      const { log, client } = fakeDocuseal();
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client, newUuid: uuids() }, id, RAW), { ok: true, submissionId: 77 }, owner);
      const request = log.find(([name]) => name === "submission")![1] as { submitters: { role: string }[] };
      assert.deepEqual(request.submitters.map((signer) => signer.role), [owner, counterparty]);
      const links = (await row(id)).signing_links as { role: string; link: string }[];
      assert.deepEqual(links.map((link) => [link.role, link.link]), [[owner, LINK_A], [counterparty, LINK_B]], "each signer has their own link");
    }
  });

  test("says the PDF is not in DocuSeal yet, with the file name, and changes nothing", async () => {
    const id = await insert();
    const { log, client } = fakeDocuseal({ findTemplateByName: (name) => (log.push(["find", name]), ok(null)) });
    const result = await sendForSignature({ db: pool!, docuseal: client }, id, RAW);
    assert.deepEqual(result, { ok: false, kind: "not-uploaded", fileName: "NDA-2026-001-beta.pdf" });
    assert.deepEqual(names(log), ["find"]);
    assert.deepEqual([(await row(id)).status, (await row(id)).docuseal_submission_id], ["generated", null]);
  });

  for (const step of ["find", "read", "fields", "submission"] as const) {
    test(`a DocuSeal failure at "${step}" is reported with its step and leaves the document as it was`, async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      // A 5xx at the submission step leaves the outcome uncertain (covered below); a refusal is certain.
      const error: DocusealError = step === "submission" ? { kind: "rejected", status: 422 } : { kind: "server-error", status: 503 };
      const overrides = {
        find: { findTemplateByName: () => failed(error) },
        read: { getTemplate: () => failed(error) },
        fields: { updateTemplate: () => failed(error) },
        submission: { createSubmission: () => failed(error) },
      }[step];
      const { client } = fakeDocuseal(overrides);
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "docuseal", step, error });
      const stored = await row(id);
      assert.deepEqual([stored.status, stored.docuseal_submission_id, stored.signing_links], ["generated", null, null]);
      assert.match(printed(lines), step === "submission" ? /docuseal-rejected-422/ : /docuseal-server-error-503/);
      assert.doesNotMatch(printed(lines), /ana@acme|ben@beta|secret-link/);
    });
  }

  test("does nothing when signing is not configured", async () => {
    const id = await insert();
    assert.deepEqual(await sendForSignature({ db: pool!, docuseal: null }, id, RAW), { ok: false, kind: "not-configured" });
    assert.equal((await row(id)).status, "generated");
  });

  test("returns the field errors and the entered values without calling DocuSeal", async () => {
    const id = await insert();
    const { log, client } = fakeDocuseal();
    const result = await sendForSignature({ db: pool!, docuseal: client }, id, { ...RAW, ownerEmail: "nope", order: "" });
    assert.equal(result.ok, false);
    if (result.ok || result.kind !== "invalid") return assert.fail("expected invalid");
    assert.deepEqual(Object.keys(result.errors).sort(), ["order", "ownerEmail"]);
    assert.equal(result.values.ownerEmail, "nope");
    assert.deepEqual(log, []);
  });

  test("answers not-found for an unknown document and wrong-status for one that is not generated", async () => {
    const { log, client } = fakeDocuseal();
    assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, 999999, RAW), { ok: false, kind: "not-found" });
    const id = await insert();
    for (const status of ["draft", "completed", "declined", "expired"]) {
      await pool!.query("update documents.documents set status = $2 where id = $1", [id, status]);
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "wrong-status", status });
    }
    assert.deepEqual(log, []);
  });

  test("is not ready when the layout does not have exactly the four boxes, or there is no PDF", async () => {
    const { log, client } = fakeDocuseal();
    const three = await insert({ fields: BOXES.slice(0, 3), ref: "NDA-2026-002" });
    const result = await sendForSignature({ db: pool!, docuseal: client }, three, RAW);
    assert.equal(result.ok === false && result.kind, "not-ready");
    assert.match(result.ok === false && result.kind === "not-ready" ? result.reason : "", /3 signature boxes/);
    const none = await insert({ pdfPath: "", ref: "NDA-2026-003" });
    const noPdf = await sendForSignature({ db: pool!, docuseal: client }, none, RAW);
    assert.equal(noPdf.ok === false && noPdf.kind, "not-ready");
    assert.match(noPdf.ok === false && noPdf.kind === "not-ready" ? noPdf.reason : "", /no PDF/i);
    assert.deepEqual(log, []);
  });

  test("a second send of a sent document creates no second submission", async () => {
    const id = await insert();
    const { log, client } = fakeDocuseal();
    assert.equal((await sendForSignature({ db: pool!, docuseal: client }, id, RAW)).ok, true);
    const before = log.length;
    assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "already-sent" });
    assert.equal(log.length, before);
    assert.equal(log.filter(([name]) => name === "submission").length, 1);
  });

  test("two sends at the same time create one submission: the second does not wait, finds the unfinished mark and calls nothing", async () => {
    const id = await insert();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { log, client } = fakeDocuseal({
      findTemplateByName: async (name) => {
        log.push(["find", name]);
        enter();
        await gate;
        return { ok: true, value: { id: 42 } };
      },
    });
    const first = sendForSignature({ db: pool!, docuseal: client }, id, RAW);
    await entered;
    // The first send is inside DocuSeal and holds no database lock: the mark is committed and visible from another connection.
    assert.notEqual((await row(id)).send_started_at, null);
    const second = await sendForSignature({ db: pool!, docuseal: client }, id, RAW);
    assert.deepEqual(second, { ok: false, kind: "unfinished" });
    assert.deepEqual(names(log), ["find"], "the second send called nothing");
    open();
    assert.deepEqual(await first, { ok: true, submissionId: 77 });
    assert.equal(log.filter(([name]) => name === "submission").length, 1);
    assert.equal((await row(id)).send_started_at, null);
  });

  test("a document that has a submission id but is still generated is not sent again", async () => {
    const id = await insert();
    await pool!.query("update documents.documents set docuseal_submission_id = 5 where id = $1", [id]);
    const { log, client } = fakeDocuseal();
    assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "already-sent" });
    assert.deepEqual(log, []);
  });

  describe("the unfinished-send mark", () => {
    const mark = async (id: number) => (await row(id)).send_started_at as Date | null;

    test("is stored and committed before DocuSeal is called, and cleared by the send that records the submission", async () => {
      const id = await insert();
      const seen: unknown[] = [];
      const { client } = fakeDocuseal({
        findTemplateByName: async () => {
          seen.push(await mark(id));
          return { ok: true, value: { id: 42 } };
        },
      });
      assert.equal((await sendForSignature({ db: pool!, docuseal: client }, id, RAW)).ok, true);
      assert.ok(seen[0] instanceof Date, "the mark was visible, committed, when DocuSeal was first asked");
      assert.equal(await mark(id), null);
    });

    test("is not written when the document is refused before DocuSeal is involved", async () => {
      const { client } = fakeDocuseal();
      const three = await insert({ fields: BOXES.slice(0, 3), ref: "NDA-2026-020" });
      assert.equal((await sendForSignature({ db: pool!, docuseal: client }, three, RAW)).ok, false);
      assert.equal(await mark(three), null);
      const invalid = await insert({ ref: "NDA-2026-021" });
      assert.equal((await sendForSignature({ db: pool!, docuseal: client }, invalid, { ...RAW, ownerEmail: "nope" })).ok, false);
      assert.equal(await mark(invalid), null);
    });

    for (const step of ["find", "read", "fields"] as const) {
      test(`is cleared when DocuSeal fails at "${step}": nothing was created`, async (t) => {
        captureConsole(t);
        const id = await insert();
        const error: DocusealError = { kind: "server-error", status: 503 };
        const overrides = { find: { findTemplateByName: () => failed(error) }, read: { getTemplate: () => failed(error) }, fields: { updateTemplate: () => failed(error) } }[step];
        assert.deepEqual(await sendForSignature({ db: pool!, docuseal: fakeDocuseal(overrides).client }, id, RAW), { ok: false, kind: "docuseal", step, error });
        assert.equal(await mark(id), null);
      });
    }

    test("is cleared when the PDF is not in DocuSeal yet", async () => {
      const id = await insert();
      const { client } = fakeDocuseal({ findTemplateByName: () => ok(null) });
      assert.equal((await sendForSignature({ db: pool!, docuseal: client }, id, RAW)).ok, false);
      assert.equal(await mark(id), null);
    });

    test("is cleared when DocuSeal refused the submission outright, and kept for any answer that leaves it uncertain", async (t) => {
      captureConsole(t);
      const refused: DocusealError[] = [{ kind: "rejected", status: 422 }, { kind: "unauthorized", status: 401 }, { kind: "not-found" }];
      for (const [index, error] of refused.entries()) {
        const id = await insert({ ref: `NDA-2026-1${String(index).padStart(2, "0")}` });
        assert.deepEqual(await sendForSignature({ db: pool!, docuseal: fakeDocuseal({ createSubmission: () => failed(error) }).client }, id, RAW), { ok: false, kind: "docuseal", step: "submission", error });
        assert.equal(await mark(id), null, error.kind);
      }
      const uncertain: DocusealError[] = [
        { kind: "outcome-unknown", reason: "timeout" },
        { kind: "outcome-unknown", reason: "interrupted" },
        { kind: "outcome-unknown", reason: "unreadable" },
        { kind: "outcome-unknown", reason: "network" },
        { kind: "server-error", status: 502 },
        { kind: "unexpected", what: "redirect" },
      ];
      for (const [index, error] of uncertain.entries()) {
        const id = await insert({ ref: `NDA-2026-2${String(index).padStart(2, "0")}` });
        const { log, client } = fakeDocuseal({ createSubmission: () => (log.push(["submission"]), failed(error)) });
        assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "outcome-unknown", error }, JSON.stringify(error));
        assert.ok((await mark(id)) instanceof Date, JSON.stringify(error));
        assert.deepEqual([(await row(id)).status, (await row(id)).docuseal_submission_id], ["generated", null]);
        // A later click does not send again.
        assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "unfinished" });
        assert.equal(log.filter(([name]) => name === "submission").length, 1);
      }
    });

    test("is released when a DocuSeal call throws before the submission was asked for, and kept when the submission call throws", async (t) => {
      captureConsole(t);
      const before = await insert({ ref: "NDA-2026-030" });
      await assert.rejects(sendForSignature({ db: pool!, docuseal: fakeDocuseal({ getTemplate: () => Promise.reject(new Error("boom")) }).client }, before, RAW), /boom/);
      assert.equal(await mark(before), null);
      const during = await insert({ ref: "NDA-2026-031" });
      await assert.rejects(sendForSignature({ db: pool!, docuseal: fakeDocuseal({ createSubmission: () => Promise.reject(new Error("boom")) }).client }, during, RAW), /boom/);
      assert.ok((await mark(during)) instanceof Date);
    });

    test("a send that finishes late only clears its own mark", async () => {
      const id = await insert();
      const other = new Date("2026-10-11T09:00:00.000Z");
      const { client } = fakeDocuseal({
        findTemplateByName: async () => {
          // The owner cleared the mark and another send claimed the document while this one was inside DocuSeal.
          await pool!.query("update documents.documents set send_started_at = $2 where id = $1", [id, other]);
          return { ok: true, value: null };
        },
      });
      assert.equal((await sendForSignature({ db: pool!, docuseal: client }, id, RAW)).ok, false);
      assert.equal((await mark(id))?.toISOString(), other.toISOString());
    });

    test("refuses a document that carries the mark, calls nothing, and never sends by itself", async () => {
      const id = await insert();
      await pool!.query("update documents.documents set send_started_at = now() where id = $1", [id]);
      const { log, client } = fakeDocuseal();
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "unfinished" });
      assert.deepEqual(log, []);
    });

    test("is cleared only by the explicit action, which touches nothing in DocuSeal, and the document can then be sent", async () => {
      const id = await insert();
      assert.equal(await clearUnfinishedSend(pool!, id), "nothing-to-clear");
      await markAged(id, SEND_MAX_DURATION_MS + 1000);
      assert.equal(await clearUnfinishedSend(pool!, id), "cleared");
      assert.equal(await mark(id), null);
      assert.equal(await clearUnfinishedSend(pool!, id), "nothing-to-clear");
      assert.equal(await clearUnfinishedSend(pool!, 999999), "nothing-to-clear");
      assert.equal((await sendForSignature({ db: pool!, docuseal: fakeDocuseal().client }, id, RAW)).ok, true);
    });

    test("is not cleared while a send may still be running, and is once the longest possible send has passed", async () => {
      const id = await insert();
      await markAged(id, 60_000);
      const before = await mark(id);
      const refused = await clearUnfinishedSend(pool!, id);
      assert.ok(typeof refused === "object" && refused.result === "too-early", JSON.stringify(refused));
      assert.ok(typeof refused === "object" && refused.waitMs > SEND_MAX_DURATION_MS - 61_000 && refused.waitMs <= SEND_MAX_DURATION_MS - 59_000, `waits about the rest of the bound: ${JSON.stringify(refused)}`);
      assert.equal((await mark(id))?.getTime(), before?.getTime(), "the mark is untouched");
      await markAged(id, SEND_MAX_DURATION_MS - 1000);
      assert.notEqual(await clearUnfinishedSend(pool!, id), "cleared");
      await markAged(id, SEND_MAX_DURATION_MS + 1000);
      assert.equal(await clearUnfinishedSend(pool!, id), "cleared");
    });

    test("a clear attempted while the first send is still inside DocuSeal is refused, so a second send cannot create a second submission", async (t) => {
      captureConsole(t);
      const id = await insert();
      const attempts: unknown[] = [];
      const { log, client } = fakeDocuseal({
        findTemplateByName: async () => {
          // The first send is inside its DocuSeal calls: the owner clears, then clicks send again.
          attempts.push(await clearUnfinishedSend(pool!, id));
          attempts.push(await sendForSignature({ db: pool!, docuseal: fakeDocuseal().client }, id, RAW));
          return { ok: true, value: { id: 42 } };
        },
      });
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: true, submissionId: 77 });
      assert.ok(typeof attempts[0] === "object" && (attempts[0] as { result: string }).result === "too-early");
      assert.deepEqual(attempts[1], { ok: false, kind: "unfinished" });
      assert.equal(log.filter(([name]) => name === "submission").length, 1);
    });

    test("a submission whose own mark is gone is not recorded over another send's mark: the ids are logged and the result says so", async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      const other = new Date("2026-10-11T09:00:00.000Z");
      const { client } = fakeDocuseal({
        createSubmission: async (request) => {
          await pool!.query("update documents.documents set send_started_at = $2 where id = $1", [id, other]);
          return { ok: true, value: { submissionId: 77, submitters: request.submitters.map((signer) => ({ role: signer.role, link: LINK_A })) } };
        },
      });
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "unrecorded", submissionId: 77 });
      assert.match(printed(lines), new RegExp(`document=${id} template=42 submission=77`));
      const stored = await row(id);
      assert.deepEqual([stored.docuseal_submission_id, stored.status, stored.send_started_at?.toISOString()], [null, "generated", other.toISOString()]);
    });

    test("cannot be cleared on a document that already holds a submission", async () => {
      const id = await insert();
      await pool!.query("update documents.documents set send_started_at = now(), docuseal_submission_id = 5 where id = $1", [id]);
      assert.equal(await clearUnfinishedSend(pool!, id), "nothing-to-clear");
      assert.notEqual(await mark(id), null);
    });
  });

  describe("when the submission cannot be recorded after DocuSeal accepted it", () => {
    interface Faults {
      /** Record statements that fail before running. */
      recordFails?: number;
      /** Record statements that run and then lose their answer. */
      recordLosesAnswer?: number;
      /** Runs when a record statement is made to fail, before the failure. */
      onRecordFault?: () => Promise<void>;
      /** The first commit runs and then loses its answer. */
      commitLosesAnswer?: boolean;
    }

    /** A pool that injects the faults above and counts each one it injected, so a test proves its fault happened. */
    function faulty(faults: Faults) {
      const injected = { recordFails: 0, recordLosesAnswer: 0, commit: 0 };
      let fails = faults.recordFails ?? 0;
      let loses = faults.recordLosesAnswer ?? 0;
      let commit = faults.commitLosesAnswer ?? false;
      const wrap = (target: { query: pg.Pool["query"] }) => ({
        query: async (text: string, values?: unknown[]) => {
          const isRecord = /update\s+documents\.documents[\s\S]*docuseal_submission_id\s*=\s*\$3/i.test(text);
          const fault = () => Object.assign(new Error(`connection reset ${LINK_A} ana@acme.test`), { code: "ECONNRESET" });
          if (isRecord && fails > 0) {
            fails -= 1;
            injected.recordFails += 1;
            await faults.onRecordFault?.();
            throw fault();
          }
          if (isRecord && loses > 0) {
            loses -= 1;
            injected.recordLosesAnswer += 1;
            await target.query(text, values);
            await faults.onRecordFault?.();
            throw fault();
          }
          return target.query(text, values);
        },
      });
      const db = {
        ...wrap(pool!),
        transaction: async <T,>(run: (tx: ReturnType<typeof wrap>) => Promise<T>): Promise<T> => {
          const done = await pool!.transaction((tx) => run(wrap(tx as never)));
          // The platform commits for the module, so a lost commit answer is the commit happening and the call failing.
          if (commit) {
            commit = false;
            injected.commit += 1;
            throw Object.assign(new Error(`connection reset ${LINK_A} ana@acme.test`), { code: "ECONNRESET" });
          }
          return done;
        },
      } as unknown as Transactional;
      return { db, injected };
    }

    test("a failed write is retried once, and a retry that works ends as a normal send that clears the mark", async () => {
      const id = await insert();
      const { db, injected } = faulty({ recordFails: 1 });
      const result = await sendForSignature({ db, docuseal: fakeDocuseal().client }, id, RAW);
      assert.equal(injected.recordFails, 1, "the fault was injected");
      assert.deepEqual(result, { ok: true, submissionId: 77 });
      const stored = await row(id);
      assert.deepEqual([stored.status, Number(stored.docuseal_submission_id), stored.send_started_at], ["sent", 77, null]);
    });

    test("a write that ran and lost its answer is recognised by the retry: one submission, recorded once", async () => {
      const id = await insert();
      let storedAtFault: unknown;
      const { db, injected } = faulty({
        recordLosesAnswer: 1,
        onRecordFault: async () => void (storedAtFault = (await row(id)).docuseal_submission_id),
      });
      const { log, client } = fakeDocuseal();
      const result = await sendForSignature({ db, docuseal: client }, id, RAW);
      assert.equal(injected.recordLosesAnswer, 1, "the fault was injected");
      assert.equal(Number(storedAtFault), 77, "the write had really been applied when its answer was lost");
      assert.deepEqual(result, { ok: true, submissionId: 77 });
      assert.equal(log.filter(([name]) => name === "submission").length, 1);
      assert.deepEqual([(await row(id)).status, (await row(id)).send_started_at], ["sent", null]);
    });

    test("when the retry fails too, the answer says it was not recorded, the ids reach the log, and the mark stays", async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      const { db, injected } = faulty({ recordFails: 2 });
      const result = await sendForSignature({ db, docuseal: fakeDocuseal().client }, id, RAW);
      assert.equal(injected.recordFails, 2, "both faults were injected");
      assert.deepEqual(result, { ok: false, kind: "unrecorded", submissionId: 77 });
      const text = printed(lines);
      assert.match(text, new RegExp(`document=${id}`));
      assert.match(text, /template=42/);
      assert.match(text, /submission=77/);
      assert.match(text, /ECONNRESET/);
      assert.doesNotMatch(text, /ana@acme|ben@beta|secret-link|sign\.example|connection reset/);
      const stored = await row(id);
      assert.deepEqual([stored.status, stored.docuseal_submission_id], ["generated", null]);
      assert.ok(stored.send_started_at instanceof Date, "the document stays marked as an unfinished send");
    });

    test("a conflict on the first write (the document now holds another submission) is reported as not recorded, with the ids logged and nothing overwritten", async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      const { client } = fakeDocuseal({
        createSubmission: async (request) => {
          await pool!.query("update documents.documents set docuseal_submission_id = 5 where id = $1", [id]);
          return { ok: true, value: { submissionId: 77, submitters: request.submitters.map((signer) => ({ role: signer.role, link: LINK_A })) } };
        },
      });
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "unrecorded", submissionId: 77 });
      assert.match(printed(lines), new RegExp(`document=${id} template=42 submission=77`));
      const stored = await row(id);
      assert.deepEqual([Number(stored.docuseal_submission_id), stored.status, stored.signing_links], [5, "generated", null]);
      assert.ok(stored.send_started_at instanceof Date);
    });

    test("a conflict on the retry (the document left generated and sent while the first write failed) is reported the same way", async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      const { db, injected } = faulty({ recordFails: 1, onRecordFault: async () => void (await pool!.query("update documents.documents set status = 'declined' where id = $1", [id])) });
      assert.deepEqual(await sendForSignature({ db, docuseal: fakeDocuseal().client }, id, RAW), { ok: false, kind: "unrecorded", submissionId: 77 });
      assert.equal(injected.recordFails, 1, "the fault was injected");
      assert.match(printed(lines), new RegExp(`document=${id} template=42 submission=77`));
      const stored = await row(id);
      assert.deepEqual([stored.status, stored.docuseal_submission_id, stored.signing_links], ["declined", null, null]);
    });

    test("an answer without a submitter for each requested role does not throw: it is reported as not recorded and the ids are logged", async (t) => {
      const lines = captureConsole(t);
      const id = await insert();
      const { client } = fakeDocuseal({
        createSubmission: async () => ({ ok: true, value: { submissionId: 77, submitters: [{ role: "Someone else", link: LINK_A }, { role: "Beta", link: LINK_B }] } }),
      });
      assert.deepEqual(await sendForSignature({ db: pool!, docuseal: client }, id, RAW), { ok: false, kind: "unrecorded", submissionId: 77 });
      const text = printed(lines);
      assert.match(text, new RegExp(`document=${id} template=42 submission=77`));
      assert.doesNotMatch(text, /ana@acme|ben@beta|secret-link|sign\.example/);
      const stored = await row(id);
      assert.deepEqual([stored.status, stored.docuseal_submission_id], ["generated", null]);
      assert.ok(stored.send_started_at instanceof Date, "marked, so a later click cannot create a second submission");
    });

    test("a commit that loses its answer while the mark is stored stops the send before DocuSeal is called", async (t) => {
      captureConsole(t);
      const id = await insert();
      const { db, injected } = faulty({ commitLosesAnswer: true });
      const { log, client } = fakeDocuseal();
      await assert.rejects(sendForSignature({ db, docuseal: client }, id, RAW), { code: "ECONNRESET" });
      assert.equal(injected.commit, 1, "the fault was injected");
      assert.deepEqual(log, [], "DocuSeal was never asked");
      assert.ok((await row(id)).send_started_at instanceof Date, "the commit had been applied: the document shows an unfinished send the owner can clear");
    });
  });
});
