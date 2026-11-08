import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { getProfile } from "../src/profile-store.ts";
import { getTemplateBySlug } from "../src/template-store.ts";
import { createElement } from "react";
import { importNotice } from "../web/templates-page.tsx";
import { importNdaFromRequest } from "../web/submit-import.ts";
import { SCRIPT_FULL, TEMPLATE, config } from "./helpers/nda-fixture.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_import_form"));
});
after(async () => {
  await pool?.end();
});
beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from documents.documents");
  await pool.query("delete from documents.templates");
  await pool.query("delete from documents.settings");
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const file = (text: string, name: string) => new File([text], name);
function request(parts: Partial<Record<string, File>>, headers: Record<string, string | undefined> = { origin: "https://app.test", host: "app.test" }): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(parts)) if (value) form.set(key, value);
  return new Request("https://app.test/documents/templates/import-nda", { method: "POST", body: form, headers: Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string]])) });
}
const good = () => ({ template: file(TEMPLATE, "nda.html"), config: file(JSON.stringify(config()), "config.json"), script: file(SCRIPT_FULL, "nda.py") });
const where = (response: Response) => [response.status, response.headers.get("location")];
const count = async (table: string) => Number((await pool!.query(`select count(*) as n from documents.${table}`)).rows[0].n);

describe("the Import NDA form", () => {
  test("creates the template and fills the profile from the uploaded files, then goes back to the list", async () => {
    const response = await importNdaFromRequest(request(good()), () => pool!);
    const [status, location] = where(response);
    assert.equal(status, 303);
    assert.match(String(location), /^\/documents\/templates\?imported=created&profile=\d+$/);
    assert.ok(await getTemplateBySlug(pool!, "nda"));
    assert.equal((await getProfile(pool!)).A_NOMBRE, "Acme Test S.A.");
  });

  test("a second import changes nothing and says so", async () => {
    await importNdaFromRequest(request(good()), () => pool!);
    const again = await importNdaFromRequest(request(good()), () => pool!);
    assert.match(String(where(again)[1]), /imported=unchanged&profile=0$/);
    assert.equal(await count("templates"), 1);
  });

  test("asks for all three files, and writes nothing without them", async () => {
    for (const parts of [{ template: good().template }, { config: good().config }, { ...good(), script: undefined }, { template: file("", "nda.html"), config: good().config }]) {
      assert.equal(where(await importNdaFromRequest(request(parts), () => pool!))[1], "/documents/templates?import_error=missing-files");
    }
    assert.deepEqual([await count("templates"), await count("settings")], [0, 0]);
  });

  test("refuses a config that is not JSON, without echoing it, and writes nothing", async () => {
    const response = await importNdaFromRequest(request({ ...good(), config: file("{ not json: secret-value", "config.json") }), () => pool!);
    assert.equal(where(response)[1], "/documents/templates?import_error=invalid-files");
    assert.deepEqual([await count("templates"), await count("settings")], [0, 0]);
  });

  test("refuses a script that is not the skill's, instead of importing a different document", async () => {
    const response = await importNdaFromRequest(request({ ...good(), script: file("print('hello')", "nda.py") }), () => pool!);
    assert.equal(where(response)[1], "/documents/templates?import_error=invalid-files");
    assert.equal(await count("templates"), 0);
  });

  test("refuses a file larger than a skill file", async () => {
    const response = await importNdaFromRequest(request({ ...good(), template: file("x".repeat(1_000_001), "nda.html") }), () => pool!);
    assert.equal(where(response)[1], "/documents/templates?import_error=too-large");
    assert.equal(await count("templates"), 0);
  });

  test("refuses a request that does not come from this site", async () => {
    for (const headers of [{ origin: "https://evil.test", host: "app.test" }, {}]) {
      assert.equal((await importNdaFromRequest(request(good(), headers), () => pool!)).status, 403);
    }
    assert.equal(await count("templates"), 0);
  });
});

describe("the notice after an import", () => {
  const text = (result: Parameters<typeof importNotice>[0]) => renderToStaticMarkup(importNotice(result) ?? createElement("span")).replace(/<[^>]+>/g, " ");
  it("says what happened for each code and shows nothing for an unknown one", () => {
    assert.match(text({ imported: "created", profile: "3" }), /NDA template was created\. 3 profile fields were added/);
    assert.match(text({ imported: "unchanged", profile: "0" }), /already exists and was left as it is\.\s*$/);
    assert.match(text({ error: "invalid-files" }), /could not be read as the skill(&#x27;|')s NDA/);
    assert.equal(text({ imported: "<script>", error: "constructor" }).trim(), "");
  });
});
