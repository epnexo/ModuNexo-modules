import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { validateTemplate } from "../src/template-rules.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;
let sql = "";

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_migration"));
  sql = await readFile(fileURLToPath(new URL("../migrations/0002_counterparty_marker.sql", import.meta.url)), "utf8");
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

const insert = (slug: string, body: string, marker: string | null = null) =>
  pool!.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html, counterparty_marker) values ($1, $1, 'nda', 'NDA', $2, $3)", [slug, body, marker]);
const markerOf = async (slug: string) => (await pool!.query("select counterparty_marker as m from documents.templates where slug = $1", [slug])).rows[0].m as string | null;

/** The migration file is run again here, against rows as an earlier import left them (the column exists already). */
const rerun = async () => {
  const client = await pool!.connect();
  try {
    await client.query("set search_path = documents");
    await client.query(sql);
  } finally {
    client.release();
  }
};

describe("migration 0002: the counterparty marker", () => {
  test("adds a nullable column that accepts only marker names", async () => {
    await insert("plain", "<p>x</p>");
    assert.equal(await markerOf("plain"), null);
    await assert.rejects(insert("bad", "<p>x</p>", "not a marker"), { code: "23514" });
  });

  test("sets the marker on an imported nda template that has none, and nothing else", async () => {
    await insert("nda", "<p>{{B_NOMBRE}} {{A_NOMBRE}}</p>");
    const before = (await pool!.query("select name, body_html, ref_prefix, updated_at from documents.templates where slug = 'nda'")).rows[0];
    await rerun();
    assert.equal(await markerOf("nda"), "B_NOMBRE");
    assert.deepEqual((await pool!.query("select name, body_html, ref_prefix, updated_at from documents.templates where slug = 'nda'")).rows[0], before);
  });

  test("leaves a template that already has a marker, another slug, or a body without B_NOMBRE untouched", async () => {
    await insert("nda", "<p>{{B_NOMBRE}} {{OTHER}}</p>", "OTHER");
    await insert("contract", "<p>{{B_NOMBRE}}</p>");
    await rerun();
    assert.equal(await markerOf("nda"), "OTHER");
    assert.equal(await markerOf("contract"), null);
    await pool!.query("delete from documents.templates");
    await insert("nda", "<p>edited, no counterparty</p>");
    await rerun();
    assert.equal(await markerOf("nda"), null);
  });

  test("can run twice", async () => {
    await insert("nda", "<p>{{B_NOMBRE}}</p>");
    await rerun();
    await rerun();
    assert.equal(await markerOf("nda"), "B_NOMBRE");
  });
});

describe("counterparty markers that validation accepts", () => {
  const candidates = ["B_NOMBRE", "A", "_", "_X", "X_", "A1", "A_1_B", "__", "REF", "a", "1A", "A-B", "A B", "ÀB", "B_NOMBRE\n", "AÑO", "", "A\u0000"];

  test("are always stored: they satisfy the column check of 0002", async () => {
    const created = await pool!.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ('t', 'T', 'nda', 'T', '<p/>') returning id");
    for (const marker of candidates) {
      const verdict = validateTemplate({ name: "T", slug: "t", kind: "nda", refPrefix: "T", bodyHtml: `<p>{{${marker}}}</p>`, counterpartyMarker: marker });
      const accepted = verdict.ok && verdict.value.counterpartyMarker === marker && marker !== "";
      if (!accepted) continue;
      await pool!.query("update documents.templates set counterparty_marker = $2 where id = $1", [created.rows[0].id, marker]);
    }
    assert.ok(candidates.filter((marker) => validateTemplate({ name: "T", slug: "t", kind: "nda", refPrefix: "T", bodyHtml: `<p>{{${marker}}}</p>`, counterpartyMarker: marker }).ok).length >= 8, "the list holds markers validation accepts");
  });
});
