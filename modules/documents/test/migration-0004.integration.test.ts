import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;
let sql = "";

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_migration4"));
  sql = await readFile(fileURLToPath(new URL("../migrations/0004_variables.sql", import.meta.url)), "utf8");
});
after(async () => {
  await pool?.end();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const insert = (slug: string, variables?: string) =>
  variables === undefined
    ? pool!.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ($1, 'm4', 'nda', 'NDA', 'x') returning id, variables", [slug])
    : pool!.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html, variables) values ($1, 'm4', 'nda', 'NDA', 'x', $2::jsonb) returning id, variables", [slug, variables]);

describe("migration 0004: variable settings", () => {
  test("adds a jsonb column that is not null and defaults to an empty object", async () => {
    const { rows } = await pool!.query("select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'documents' and table_name = 'templates' and column_name = 'variables'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data_type, "jsonb");
    assert.equal(rows[0].is_nullable, "NO");
    assert.match(rows[0].column_default, /'\{\}'::jsonb/);
  });

  test("gives a template inserted without settings an empty object", async () => {
    const { rows } = await insert("m4-default");
    assert.deepEqual(rows[0].variables, {});
  });

  test("keeps the settings of a template as they are written", async () => {
    const settings = { B_NOMBRE: { label: "Nombre", kind: "line" } };
    const { rows } = await insert("m4-set", JSON.stringify(settings));
    assert.deepEqual(rows[0].variables, settings);
  });

  test("refuses anything that is not a JSON object", async () => {
    for (const bad of ["[]", '"text"', "3", "null", "true"]) {
      await assert.rejects(insert(`m4-bad-${bad.length}-${bad[0]}`, bad), (error: { code?: string; constraint?: string }) => error.code === "23514" || error.code === "23502", bad);
    }
  });

  test("is harmless to run again and keeps the settings already stored", async () => {
    const settings = { FECHA: { label: "Fecha", kind: "date", locale: "es" } };
    const { rows } = await insert("m4-again", JSON.stringify(settings));
    const client = await pool!.connect();
    try {
      await client.query("set search_path = documents");
      await client.query(sql);
    } finally {
      client.release();
    }
    const after = await pool!.query("select variables from documents.templates where id = $1", [rows[0].id]);
    assert.deepEqual(after.rows[0].variables, settings);
  });
});
