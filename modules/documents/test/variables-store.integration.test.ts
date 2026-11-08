import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import type { TemplateInput } from "../src/template-rules.ts";
import { archiveTemplate, createTemplate, getTemplate, listTemplates, lockVariables, setVariables, updateTemplate } from "../src/template-store.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_variables_store"));
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

const input = (extra: Partial<TemplateInput> = {}): TemplateInput => ({ name: "NDA", slug: "nda", kind: "nda", refPrefix: "NDA", bodyHtml: "<p>{{B_NOMBRE}} {{FECHA}}</p>", counterpartyMarker: null, ...extra });
const SETTINGS = { B_NOMBRE: { label: "Nombre de la contraparte", help: "Razón social" }, FECHA: { kind: "date" as const, locale: "es" as const } };
const created = async (variables?: typeof SETTINGS | Record<string, never>) => {
  const result = await createTemplate(pool!, input(), variables);
  assert.ok(result.ok);
  return result.ok ? result.id : 0;
};

describe("template store: variable settings", () => {
  test("a template created without settings reads back with an empty object", async () => {
    assert.deepEqual((await getTemplate(pool!, await created()))?.variables, {});
  });

  test("creates a template with settings and reads them back through getTemplate and listTemplates", async () => {
    const id = await created(SETTINGS);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, SETTINGS);
    assert.deepEqual((await listTemplates(pool!))[0]?.variables, SETTINGS);
  });

  test("update replaces the settings when it is given some, and leaves them alone when it is not", async () => {
    const id = await created(SETTINGS);
    assert.equal(await updateTemplate(pool!, id, input({ name: "Renamed" })), "updated");
    assert.deepEqual((await getTemplate(pool!, id))?.variables, SETTINGS, "an update without settings keeps them");
    assert.equal(await updateTemplate(pool!, id, input(), { PIE: { label: "Pie" } }), "updated");
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { PIE: { label: "Pie" } });
    assert.equal(await updateTemplate(pool!, id, input(), {}), "updated");
    assert.deepEqual((await getTemplate(pool!, id))?.variables, {}, "an empty object clears them");
  });

  test("stores text with quotes, backslashes and braces as is (parameterized)", async () => {
    const tricky = { A: { label: `it's "x" \\ {{B}}`, help: "'; drop table documents.templates; --" } };
    const result = await createTemplate(pool!, input(), tricky);
    assert.ok(result.ok);
    assert.deepEqual(result.ok && (await getTemplate(pool!, result.id))?.variables, tricky);
    assert.equal((await listTemplates(pool!)).length, 1);
  });

  test("reads a row written by hand with odd content as the settings it can use", async () => {
    const id = await created();
    await pool!.query("update documents.templates set variables = $2::jsonb where id = $1", [id, JSON.stringify({ OK: { label: "kept" }, lower: { label: "x" }, BAD: "text", ALSO: { kind: "number" } })]);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { OK: { label: "kept" } });
  });
});

describe("lockVariables and setVariables", () => {
  test("reads the settings of a template and null for one that does not exist", async () => {
    const id = await created(SETTINGS);
    assert.deepEqual(await lockVariables(pool!, id), SETTINGS);
    assert.equal(await lockVariables(pool!, 999999), null);
  });

  test("the lock holds the row until the transaction ends", async () => {
    const id = await created(SETTINGS);
    const holder = await pool!.connect();
    const other = await pool!.connect();
    try {
      await holder.query("begin");
      await lockVariables(holder, id);
      await other.query("begin");
      await other.query("set local lock_timeout = '200ms'");
      await assert.rejects(lockVariables(other, id), (error: { code?: string }) => error.code === "55P03");
      await other.query("rollback");
      await holder.query("commit");
    } finally {
      holder.release();
      other.release();
    }
  });

  test("writes the settings of a template and says so", async () => {
    const id = await created();
    assert.equal(await setVariables(pool!, id, SETTINGS), true);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, SETTINGS);
  });

  test("replaces what was there, the way the caller built it from what it read", async () => {
    const id = await created(SETTINGS);
    assert.equal(await setVariables(pool!, id, { PIE: { label: "Other" } }), true);
    assert.deepEqual((await getTemplate(pool!, id))?.variables, { PIE: { label: "Other" } });
  });

  test("touches no other column, not even updated_at", async () => {
    const id = await created();
    const before = (await pool!.query("select slug, name, kind, ref_prefix, body_html, counterparty_marker, created_at, updated_at, archived_at from documents.templates where id = $1", [id])).rows[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await setVariables(pool!, id, SETTINGS), true);
    const after = (await pool!.query("select slug, name, kind, ref_prefix, body_html, counterparty_marker, created_at, updated_at, archived_at from documents.templates where id = $1", [id])).rows[0];
    assert.deepEqual(after, before);
  });

  test("reports false for an unknown id", async () => {
    assert.equal(await setVariables(pool!, 999999, SETTINGS), false);
  });

  test("works on an archived template too: it is a column of the row, not an edit", async () => {
    const id = await created();
    await archiveTemplate(pool!, id);
    assert.equal(await setVariables(pool!, id, SETTINGS), true);
  });
});
