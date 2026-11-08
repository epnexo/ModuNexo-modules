import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { openMigratedPool } from "./helpers/db.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let sql = "";

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_migration3"));
  sql = await readFile(fileURLToPath(new URL("../migrations/0003_send_started_at.sql", import.meta.url)), "utf8");
});
after(async () => {
  await pool?.end();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

describe("migration 0003: the unfinished-send mark", () => {
  test("adds a nullable timestamp column that is empty for every document", async () => {
    const { rows } = await pool!.query("select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'documents' and table_name = 'documents' and column_name = 'send_started_at'");
    assert.deepEqual(rows, [{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
  });

  test("is harmless to run again and keeps a mark that is already set", async () => {
    const template = await pool!.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ('m3', 'm3', 'nda', 'NDA', 'x') returning id");
    const doc = await pool!.query(
      "insert into documents.documents (ref, template_id, template_body_snapshot, title, counterparty_name, send_started_at) values ('NDA-2026-901', $1, 'x', 't', 'c', '2026-10-11T10:00:00Z') returning id",
      [template.rows[0].id],
    );
    const client = await pool!.connect();
    try {
      await client.query("set search_path = documents");
      await client.query(sql);
    } finally {
      client.release();
    }
    const { rows } = await pool!.query("select send_started_at from documents.documents where id = $1", [doc.rows[0].id]);
    assert.equal(rows[0].send_started_at.toISOString(), "2026-10-11T10:00:00.000Z");
    await pool!.query("delete from documents.documents where id = $1", [doc.rows[0].id]);
    await pool!.query("delete from documents.templates where id = $1", [template.rows[0].id]);
  });
});
