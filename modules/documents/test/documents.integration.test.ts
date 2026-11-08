import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Registry, coreManifest, discoverModules, migrate } from "@epnexo/core";
import { openTestPool, resolveTestDatabaseUrl } from "@epnexo/core/testing";
import type pg from "pg";
import { listDocuments } from "../web/queries.ts";

const modulesDir = fileURLToPath(new URL("../..", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
/** Rows counted right after the migration ran, before any test inserted anything. */
let rowsAfterMigrate: Record<string, number> = {};

/** The module gets its own database (`<name>_documents_test`) so parallel test files never see its rows. */
function documentsTestEnv(): NodeJS.ProcessEnv {
  const base = resolveTestDatabaseUrl();
  if (!base) return process.env;
  const url = new URL(base);
  url.pathname = url.pathname.replace(/_test$/, "_documents_test");
  return { ...process.env, TEST_DATABASE_URL: url.toString() };
}

const TABLES = ["templates", "documents", "counters", "settings"];

before(async () => {
  ({ pool, skipReason } = await openTestPool(documentsTestEnv()));
  if (!pool) return;
  // Start from nothing so "zero rows after migrate" is checked against a fresh schema on every run.
  await pool.query("drop schema if exists documents cascade");
  const tracking = await pool.query("select to_regclass('core.schema_migrations') is not null as present");
  if (tracking.rows[0].present) await pool.query("delete from core.schema_migrations where module_id = 'documents'");
  const registry = new Registry();
  registry.register(coreManifest);
  for (const manifest of await discoverModules(modulesDir)) registry.register(manifest);
  await migrate(pool, registry);
  for (const table of TABLES) {
    rowsAfterMigrate[table] = Number((await pool.query(`select count(*) as n from documents.${table}`)).rows[0].n);
  }
});

after(async () => {
  await pool?.end();
});

const q = (sql: string, values: unknown[] = []) => pool!.query(sql, values);

/** Run a statement that must be rejected and return the Postgres error code. */
async function rejection(sql: string, values: unknown[] = []): Promise<string | undefined> {
  try {
    await q(sql, values);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

async function insertTemplate(slug: string, kind = "nda", name = "Mutual NDA"): Promise<number> {
  const { rows } = await q(
    "insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ($1, $2, $3, 'NDA', '<p>{{X}}</p>') returning id",
    [slug, name, kind],
  );
  return Number(rows[0].id);
}

async function insertDocument(templateId: number, ref: string, extra: { status?: string; createdAt?: string; title?: string; counterparty?: string; pdfPath?: string } = {}) {
  await q(
    `insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data, status, created_at, pdf_path)
     values ($1, $2, '<p>{{X}}</p>', $3, $4, '{}'::jsonb, $5, coalesce($6::timestamptz, now()), $7)`,
    [ref, templateId, extra.title ?? "Mutual NDA", extra.counterparty ?? "Acme", extra.status ?? "draft", extra.createdAt ?? null, extra.pdfPath ?? null],
  );
}

describe("documents schema", () => {
  const test = (name: string, run: () => Promise<void>) =>
    it(name, async (t) => {
      if (!pool) return t.skip(skipReason);
      await run();
    });

  test("creates the four tables and inserts no rows", async () => {
    const { rows } = await q("select table_name from information_schema.tables where table_schema = 'documents' order by 1");
    assert.deepEqual(rows.map((r) => r.table_name), ["counters", "documents", "settings", "templates"]);
    assert.deepEqual(rowsAfterMigrate, { templates: 0, documents: 0, counters: 0, settings: 0 });
  });

  test("applies nothing on a second run", async () => {
    const registry = new Registry();
    registry.register(coreManifest);
    for (const manifest of await discoverModules(modulesDir)) registry.register(manifest);
    assert.deepEqual((await migrate(pool!, registry)).applied, []);
  });

  test("rejects an unknown template kind and a duplicate slug", async () => {
    await q("delete from documents.documents");
    await q("delete from documents.templates");
    assert.equal(await rejection("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ('bad', 'Bad', 'memo', 'MEM', '')"), CHECK_VIOLATION);
    for (const kind of ["nda", "contract", "proposal", "other"]) await insertTemplate(`ok-${kind}`, kind);
    assert.equal(await rejection("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ('ok-nda', 'Dup', 'nda', 'NDA', '')"), UNIQUE_VIOLATION);
  });

  test("rejects an unknown status, defaults to draft and keeps ref unique", async () => {
    await q("delete from documents.documents");
    await q("delete from documents.templates");
    const templateId = await insertTemplate("nda");
    assert.equal(
      await rejection(
        "insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data, status) values ('NDA-2026-001', $1, '', 't', 'c', '{}', 'signed')",
        [templateId],
      ),
      CHECK_VIOLATION,
    );
    await q(
      "insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data) values ('NDA-2026-001', $1, '', 't', 'c', '{}')",
      [templateId],
    );
    assert.equal((await q("select status from documents.documents where ref = 'NDA-2026-001'")).rows[0].status, "draft");
    assert.equal(await rejection("insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data) values ('NDA-2026-001', $1, '', 't', 'c', '{}')", [templateId]), UNIQUE_VIOLATION);
  });

  test("refuses a document without an existing template", async () => {
    assert.equal(await rejection("insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, data) values ('X-1', 999999, '', 't', 'c', '{}')"), "23503");
  });

  test("keeps the owner profile to a single row", async () => {
    await q("delete from documents.settings");
    await q("insert into documents.settings (profile) values ('{\"company\":\"Epnexo\"}')");
    assert.notEqual(await rejection("insert into documents.settings (profile) values ('{}')"), undefined);
    assert.notEqual(await rejection("insert into documents.settings (id, profile) values (2, '{}')"), undefined);
    assert.equal(Number((await q("select count(*) as n from documents.settings")).rows[0].n), 1);
  });

  test("identifies a counter by prefix and year", async () => {
    await q("delete from documents.counters");
    await q("insert into documents.counters (prefix, year, last_number) values ('NDA', 2026, 1), ('NDA', 2027, 1), ('CON', 2026, 1)");
    assert.equal(await rejection("insert into documents.counters (prefix, year, last_number) values ('NDA', 2026, 5)"), UNIQUE_VIOLATION);
  });
});

describe("listDocuments", () => {
  const test = (name: string, run: () => Promise<void>) =>
    it(name, async (t) => {
      if (!pool) return t.skip(skipReason);
      await run();
    });

  test("returns an empty list when there are no documents", async () => {
    await q("delete from documents.documents");
    assert.deepEqual(await listDocuments(pool!), []);
  });

  test("returns the registry columns with the template, newest first", async () => {
    await q("delete from documents.documents");
    await q("delete from documents.templates");
    const nda = await insertTemplate("nda", "nda", "Mutual NDA");
    const contract = await insertTemplate("services", "contract", "Services contract");
    await insertDocument(nda, "NDA-2026-001", { createdAt: "2026-10-01T10:00:00Z", status: "completed", title: "NDA Acme", counterparty: "Acme" });
    await insertDocument(contract, "CON-2026-001", { createdAt: "2026-10-03T10:00:00Z", status: "sent", title: "Services Globex", counterparty: "Globex", pdfPath: "CON-2026-001-globex.pdf" });
    await insertDocument(nda, "NDA-2026-002", { createdAt: "2026-10-02T10:00:00Z", pdfPath: "  " });

    const rows = await listDocuments(pool!);
    assert.deepEqual(rows.map((r) => r.ref), ["CON-2026-001", "NDA-2026-002", "NDA-2026-001"]);
    const { id, ...first } = rows[0]!;
    assert.equal(typeof id, "number");
    assert.deepEqual(first, {
      ref: "CON-2026-001",
      title: "Services Globex",
      counterpartyName: "Globex",
      templateName: "Services contract",
      kind: "contract",
      status: "sent",
      createdAt: new Date("2026-10-03T10:00:00Z"),
      hasPdf: true,
    });
    assert.equal(rows[1]!.status, "draft");
    assert.deepEqual(rows.map((r) => r.hasPdf), [true, false, false], "a blank path is no PDF, by the same rule as the download");
  });
});
