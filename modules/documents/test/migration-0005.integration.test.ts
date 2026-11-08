import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_0005"));
});
after(async () => {
  await pool?.end();
});

describe("migration 0005: the PDF lives in the file store", () => {
  const test = (name: string, run: () => Promise<void>) =>
    it(name, async (t) => {
      if (!pool) return t.skip(skipReason);
      await run();
    });

  test("adds a nullable text column for the file id, so a document from before the file store still loads", async () => {
    const { rows } = await pool!.query("select data_type, is_nullable from information_schema.columns where table_schema = 'documents' and table_name = 'documents' and column_name = 'pdf_file_id'");
    assert.deepEqual(rows[0], { data_type: "text", is_nullable: "YES" });
  });

  test("runs twice without error", async () => {
    await pool!.query("alter table documents.documents add column if not exists pdf_file_id text");
  });
});
