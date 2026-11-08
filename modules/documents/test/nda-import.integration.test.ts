import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { formatImportReport, importNda, parseImportArgs } from "../src/nda-import.ts";
import { getProfile, saveProfile } from "../src/profile-store.ts";
import { archiveTemplate, getTemplateBySlug, listTemplates, updateTemplate } from "../src/template-store.ts";
import type { VariableSettings } from "../src/variables.ts";
import { SCRIPT, SCRIPT_FULL, TEMPLATE, config } from "./helpers/nda-fixture.ts";
import { type TestDb, openMigratedPool } from "./helpers/db.ts";

let pool: TestDb | undefined;
let skipReason: string | undefined;
let skillDir: string;

async function writeSkill(dir: string, cfg: unknown = config(), script: string = SCRIPT_FULL) {
  await mkdir(join(dir, "templates"), { recursive: true });
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "templates", "nda.html"), TEMPLATE);
  await writeFile(join(dir, "scripts", "nda.py"), script);
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg));
}

before(async () => {
  ({ pool, skipReason } = await openMigratedPool("documents_import"));
  skillDir = await mkdtemp(join(tmpdir(), "documents-import-"));
  await writeSkill(skillDir);
});

after(async () => {
  await pool?.end();
  await rm(skillDir, { recursive: true, force: true });
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

describe("importNda", () => {
  test("creates the template and fills the profile from the config", async () => {
    const report = await importNda(pool!, skillDir);
    assert.equal(report.template.status, "created");
    const template = await getTemplateBySlug(pool!, "nda");
    assert.ok(template);
    assert.deepEqual([template.kind, template.refPrefix, template.archivedAt], ["nda", "NDA", null]);
    assert.ok(template.bodyHtml.includes("{{B_NOMBRE}}"));
    assert.equal(template.counterpartyMarker, "B_NOMBRE", "the counterparty name comes from the NDA's counterparty-name marker");
    assert.ok(!template.bodyHtml.includes("{{CLAUSULA_CONOCIMIENTO}}"));
    assert.equal((await getProfile(pool!)).A_NOMBRE, "Acme Test S.A.");
    assert.ok(report.profileAdded.includes("A_NOMBRE") && report.profileAdded.includes("MESES"));
  });

  test("changes nothing on a second run and says so", async () => {
    await importNda(pool!, skillDir);
    const before = await getTemplateBySlug(pool!, "nda");
    const profileBefore = await pool!.query("select profile, updated_at from documents.settings");
    const report = await importNda(pool!, skillDir);

    assert.equal(report.template.status, "unchanged");
    assert.deepEqual(report.profileAdded, []);
    assert.equal(report.changed, false);
    assert.match(formatImportReport(report).join("\n"), /nothing changed/i);
    assert.deepEqual(await getTemplateBySlug(pool!, "nda"), before);
    assert.deepEqual((await pool!.query("select profile, updated_at from documents.settings")).rows, profileBefore.rows);
    assert.equal((await listTemplates(pool!)).length, 1);
  });

  test("never overwrites a template that was edited in the platform", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    await updateTemplate(pool!, created.id, { name: "My NDA", slug: "nda", kind: "nda", refPrefix: "MYN", bodyHtml: "<p>edited {{X}}</p>", counterpartyMarker: null });
    const report = await importNda(pool!, skillDir);
    assert.equal(report.template.status, "unchanged");
    const after = (await getTemplateBySlug(pool!, "nda"))!;
    assert.deepEqual([after.name, after.refPrefix, after.bodyHtml], ["My NDA", "MYN", "<p>edited {{X}}</p>"]);
  });

  test("does not bring back a template that was archived", async () => {
    await importNda(pool!, skillDir);
    await archiveTemplate(pool!, (await getTemplateBySlug(pool!, "nda"))!.id);
    const report = await importNda(pool!, skillDir);
    assert.equal(report.template.status, "unchanged");
    assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 1);
  });

  test("fills only the profile keys that are not there yet", async () => {
    await saveProfile(pool!, { set: { A_NOMBRE: "Edited in the platform", CUSTOM: "kept" }, remove: [] });
    const report = await importNda(pool!, skillDir);
    const profile = await getProfile(pool!);
    assert.equal(profile.A_NOMBRE, "Edited in the platform");
    assert.equal(profile.CUSTOM, "kept");
    assert.equal(profile.A_EMAIL, "legal@acme.test");
    assert.ok(!report.profileAdded.includes("A_NOMBRE"));
    assert.ok(report.profileAdded.includes("A_EMAIL"));
  });

  test("adds a key the owner later blanked out in the platform, since it is not there", async () => {
    await importNda(pool!, skillDir);
    await saveProfile(pool!, { set: {}, remove: ["A_CARGO"] });
    const report = await importNda(pool!, skillDir);
    assert.deepEqual(report.profileAdded, ["A_CARGO"]);
  });

  test("the report names parts and keys but carries no owner values", async () => {
    const report = await importNda(pool!, skillDir);
    const text = formatImportReport(report).join("\n");
    for (const value of ["Acme", "legal@acme.test", "Pat Example", "1 Test Street", "invented shared material", "#112233", "the invented law"]) {
      assert.ok(!text.includes(value), value);
    }
    assert.match(text, /Optional clause/);
    assert.match(text, /A_NOMBRE/);
  });

  test("stops with a clear error, and writes nothing, when the config is not usable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "documents-import-"));
    try {
      await writeSkill(dir, config({ mi_empresa: { ...config().mi_empresa, nombre: "Mi Empresa S.R.L." } }));
      await assert.rejects(importNda(pool!, dir), /example/i);
      assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 0);
      assert.deepEqual(await getProfile(pool!), {});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes the template and the profile in one transaction: a failing profile write leaves no template", async () => {
    const failsOnSettings = {
      query: pool!.query.bind(pool!),
      transaction: <T,>(run: (tx: { query: TestDb["query"] }) => Promise<T>) =>
        pool!.transaction((tx) => run({ query: ((text: string, values?: unknown[]) => (/documents\.settings/.test(text) ? Promise.reject(new Error("boom")) : tx.query(text, values))) as never })),
    };
    await assert.rejects(importNda(failsOnSettings, skillDir), /boom/);
    assert.equal(Number((await pool!.query("select count(*) as n from documents.templates")).rows[0].n), 0);
    assert.deepEqual(await getProfile(pool!), {});
    assert.equal((await importNda(pool!, skillDir)).template.status, "created", "a rerun recovers");
  });

  test("names the missing skill file without printing absolute paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "documents-import-"));
    try {
      await assert.rejects(importNda(pool!, dir), (error: Error) => /templates\/nda\.html/.test(error.message) && !error.message.includes(dir));
      await mkdir(join(dir, "templates"), { recursive: true });
      await writeFile(join(dir, "templates", "nda.html"), TEMPLATE);
      await assert.rejects(importNda(pool!, dir), /config\.json/);
      await writeFile(join(dir, "config.json"), "{not json");
      await assert.rejects(importNda(pool!, dir), (error: Error) => /config\.json/.test(error.message) && /not valid JSON/i.test(error.message));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("importNda: the NDA's variable settings", () => {
  const variablesOf = async () => (await getTemplateBySlug(pool!, "nda"))!.variables;
  const NDA_ASKED = ["B_NOMBRE", "B_CORTO", "B_DATOS", "B_INFO", "B_FIRMANTE", "FINALIDAD", "INTRO", "PIE", "FECHA", "LEY_DATOS"];

  test("sets the settings of the markers the template asks when it creates the template", async () => {
    const report = await importNda(pool!, skillDir);
    const variables = await variablesOf();
    assert.deepEqual(Object.keys(variables).sort(), [...NDA_ASKED].sort());
    assert.equal(variables.B_NOMBRE!.label, "Nombre de la contraparte");
    assert.equal(variables.FINALIDAD!.default, "evaluate an invented collaboration");
    assert.deepEqual(variables.FECHA, { label: "Fecha de efectos", help: variables.FECHA!.help!, kind: "date", locale: "es" });
    assert.equal(variables.LEY_DATOS!.default, "the invented law of Zedland, as well as the invented law of the other party", "the owner's country decides the law");
    assert.equal(variables.B_CORTO!.default, "{{B_NOMBRE}}");
    assert.equal(variables.INTRO!.default, "Antes de compartir información sensible, {{A_CORTO}} y {{B_CORTO}} dejan por escrito cómo la van a proteger. Las mismas reglas aplican a las dos partes.");
    assert.equal(variables.PIE!.default, "{{A_CORTO}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}");
    assert.equal(variables.B_FIRMANTE!.default, undefined, "the signer has no default");
    assert.equal(report.variables.status, "set");
    assert.equal(report.variables.count, 10);
    assert.equal(report.changed, true);
  });

  test("a second run changes nothing, writes nothing and says the settings were left", async () => {
    await importNda(pool!, skillDir);
    const before = await getTemplateBySlug(pool!, "nda");
    const report = await importNda(pool!, skillDir);
    assert.equal(report.variables.status, "kept");
    assert.equal(report.changed, false);
    assert.deepEqual(await getTemplateBySlug(pool!, "nda"), before);
    assert.match(formatImportReport(report).join("\n"), /Variables: nothing was empty/);
    assert.match(formatImportReport(report).join("\n"), /Nothing changed/);
  });

  test("gives settings to an existing template that has none, and touches nothing else of it", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    await pool!.query("update documents.templates set variables = '{}'::jsonb, name = 'Edited name', body_html = body_html || ' {{EXTRA}}' where id = $1", [created.id]);
    const before = (await pool!.query("select * from documents.templates where id = $1", [created.id])).rows[0];
    const report = await importNda(pool!, skillDir);
    const after = (await pool!.query("select * from documents.templates where id = $1", [created.id])).rows[0];

    assert.equal(report.template.status, "unchanged");
    assert.equal(report.variables.status, "filled");
    assert.equal(report.changed, true);
    assert.deepEqual({ ...after, variables: undefined }, { ...before, variables: undefined }, "the body, the name, the timestamps and every other column are as they were");
    assert.deepEqual(Object.keys(after.variables).sort(), [...NDA_ASKED].sort(), "EXTRA is a marker the NDA table does not know, so it has no entry");
    assert.equal((await importNda(pool!, skillDir)).variables.status, "kept", "and the next run leaves it");
  });

  test("fills only the pieces that are empty and never overwrites one that is set", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    const mine: VariableSettings = { B_NOMBRE: { label: "My own label" }, FINALIDAD: { default: "my own purpose", kind: "line" }, INTRO: { default: "my intro" } };
    await pool!.query("update documents.templates set variables = $2::jsonb where id = $1", [created.id, JSON.stringify(mine)]);
    const report = await importNda(pool!, skillDir);
    const variables = await variablesOf();
    assert.equal(report.variables.status, "filled");
    assert.equal(variables.B_NOMBRE!.label, "My own label");
    assert.equal(variables.B_NOMBRE!.kind, "line", "the empty kind was filled");
    assert.ok(variables.B_NOMBRE!.help);
    assert.deepEqual([variables.FINALIDAD!.default, variables.FINALIDAD!.kind], ["my own purpose", "line"]);
    assert.equal(variables.FINALIDAD!.label, "Finalidad de la colaboración");
    assert.equal(variables.INTRO!.default, "my intro");
    assert.equal(variables.PIE!.default, "{{A_CORTO}} y {{B_CORTO}} · Acuerdo de confidencialidad {{REF}}");
    assert.equal(report.variables.filled.find((entry) => entry.marker === "B_NOMBRE")?.pieces.join(), "help,kind");
    assert.equal((await importNda(pool!, skillDir)).variables.status, "kept", "idempotent");
  });

  test("completes a template set up before the composed defaults existed, touching only the three defaults, and says what it filled", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    const old = structuredClone(created.variables);
    for (const marker of ["B_CORTO", "INTRO", "PIE"]) delete old[marker]!.default;
    await pool!.query("update documents.templates set variables = $2::jsonb where id = $1", [created.id, JSON.stringify(old)]);
    const before = (await pool!.query("select * from documents.templates where id = $1", [created.id])).rows[0];

    const report = await importNda(pool!, skillDir);
    const after = (await pool!.query("select * from documents.templates where id = $1", [created.id])).rows[0];
    assert.equal(report.variables.status, "filled");
    assert.deepEqual([...report.variables.filled].sort((a, b) => a.marker.localeCompare(b.marker)), [{ marker: "B_CORTO", pieces: ["default"] }, { marker: "INTRO", pieces: ["default"] }, { marker: "PIE", pieces: ["default"] }]);
    assert.deepEqual({ ...after, variables: undefined }, { ...before, variables: undefined });
    assert.deepEqual(after.variables, created.variables);
    const text = formatImportReport(report).join("\n");
    assert.match(text, /filled the empty settings of 3 markers/);
    assert.match(text, /B_CORTO: default/);
    assert.match(text, /PIE: default/);

    const again = await importNda(pool!, skillDir);
    assert.equal(again.variables.status, "kept");
    assert.equal(again.changed, false);
    assert.match(formatImportReport(again).join("\n"), /Nothing changed/);
  });

  test("gives an edited template settings only for the markers it still has", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    await pool!.query("update documents.templates set variables = '{}'::jsonb, body_html = '<p>{{B_NOMBRE}} {{FECHA}} {{A_NOMBRE}} {{OTHER}}</p>' where id = $1", [created.id]);
    const report = await importNda(pool!, skillDir);
    assert.deepEqual(Object.keys(await variablesOf()).sort(), ["B_NOMBRE", "FECHA"]);
    assert.equal(report.variables.count, 2);
  });

  test("sets nothing and says so when the template asks for none of the NDA's markers", async () => {
    await importNda(pool!, skillDir);
    const created = (await getTemplateBySlug(pool!, "nda"))!;
    await pool!.query("update documents.templates set variables = '{}'::jsonb, body_html = '<p>{{ONLY_THIS}}</p>' where id = $1", [created.id]);
    const report = await importNda(pool!, skillDir);
    assert.equal(report.variables.status, "none");
    assert.equal(report.changed, false);
    assert.deepEqual(await variablesOf(), {});
  });

  test("leaves a default empty, with a note, when the skill's script does not have it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "documents-import-"));
    try {
      await writeSkill(dir, config(), SCRIPT);
      const report = await importNda(pool!, dir);
      const variables = await variablesOf();
      assert.equal(variables.FINALIDAD!.default, undefined);
      assert.equal(variables.FINALIDAD!.label, "Finalidad de la colaboración");
      assert.ok(report.variables.warnings.some((w) => w.includes("FINALIDAD")));
      assert.match(formatImportReport(report).join("\n"), /FINALIDAD/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the report names the markers that start with a default, today's date or nothing, and why, without values", async () => {
    const text = formatImportReport(await importNda(pool!, skillDir)).join("\n");
    assert.match(text, /Variables: set for 10 markers/);
    const defaults = text.match(/defaults filled: ([^\n]*)/)?.[1] ?? "";
    for (const marker of ["FINALIDAD", "B_INFO", "LEY_DATOS", "B_CORTO", "INTRO", "PIE"]) assert.ok(defaults.includes(marker), marker);
    assert.match(text, /today's date: FECHA/);
    assert.match(text, /- B_FIRMANTE: .*representative and position/);
    assert.doesNotMatch(text, /- INTRO:|- PIE:|- B_CORTO:/);
    for (const value of ["evaluate an invented collaboration", "Zedland", "invented information", "ZZ"]) assert.ok(!text.includes(value), value);
  });

  test("the settings and the template are written together: a failing write leaves neither", async () => {
    const failsOnSettings = {
      query: pool!.query.bind(pool!),
      transaction: <T,>(run: (tx: { query: TestDb["query"] }) => Promise<T>) =>
        pool!.transaction((tx) => run({ query: ((text: string, values?: unknown[]) => (/documents\.settings/.test(text) ? Promise.reject(new Error("boom")) : tx.query(text, values))) as never })),
    };
    await assert.rejects(importNda(failsOnSettings, skillDir), /boom/);
    assert.equal(await getTemplateBySlug(pool!, "nda"), null);
  });
});

describe("parseImportArgs", () => {
  it("takes the skill folder from --skill-dir, with a space or an equals sign", () => {
    assert.deepEqual(parseImportArgs(["--skill-dir", "/a/b"]), { skillDir: "/a/b" });
    assert.deepEqual(parseImportArgs(["--skill-dir=/a/b"]), { skillDir: "/a/b" });
  });

  it("expands a leading ~ to the home folder", () => {
    assert.match(parseImportArgs(["--skill-dir", "~/skill"]).skillDir, /^\/.+\/skill$/);
    assert.ok(!parseImportArgs(["--skill-dir", "~/skill"]).skillDir.includes("~"));
  });

  it("rejects a missing folder, a missing value and unknown flags", () => {
    assert.throws(() => parseImportArgs([]), /--skill-dir/);
    assert.throws(() => parseImportArgs(["--skill-dir"]), /--skill-dir/);
    assert.throws(() => parseImportArgs(["--skill-dir", "--other"]), /--skill-dir/);
    assert.throws(() => parseImportArgs(["--skill-dir", "/a", "--force"]), /unknown/i);
    assert.throws(() => parseImportArgs(["/a"]), /unknown/i);
  });
});
