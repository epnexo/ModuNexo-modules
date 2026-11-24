import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest, type JobContext } from "@modunexo/sdk";
import { ActionError, ActionService, type Actor } from "@modunexo/core/actions";
import { moduleRolesFor } from "@modunexo/core/data";
import { registerModuleRuntime } from "@modunexo/core/job-runtime";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { createScratchDatabase } from "@modunexo/core/testing";
import { migrate } from "../helpers/migrate.ts";
import documents from "../../modules/documents/manifest.ts";
import archiveTemplateJob from "../../modules/documents/jobs/archive-template.ts";

const MODULE_DIR = fileURLToPath(new URL("../../modules/documents/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let service: ActionService;

const person = (name: string, permissions: string[]): Actor => ({ name, via: "portal", can: (permission) => permissions.includes(permission) });
const agent: Actor = { name: "mcp:laptop", via: "mcp", can: () => true };

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(documents);
  await migrate(pool, registry, { moduleDirs: { documents: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('documents', 'enabled', $1)", [documents.version]);
  registerModuleRuntime(pool, { current: registry });
  service = new ActionService(pool, registry, { moduleRoles: moduleRolesFor(pool) });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("delete from core.action_proposals");
  await pool.query("delete from core.jobs where module_id = 'documents'");
  await pool.query("delete from documents.templates");
  await pool.query("insert into documents.templates (slug, name, kind, ref_prefix, body_html) values ('nda', 'NDA mutual', 'nda', 'NDA', '<p>x</p>'), ('svc', 'Service contract', 'contract', 'SVC', '<p>y</p>')");
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });
const idOf = async (slug: string) => Number((await pool!.query("select id from documents.templates where slug = $1", [slug])).rows[0].id);
const archived = async (slug: string) => (await pool!.query("select archived_at is not null as a from documents.templates where slug = $1", [slug])).rows[0].a as boolean;
const ctx = (payload: unknown): JobContext => ({ moduleId: "documents", jobName: "archive_template", jobId: 1, attempt: 1, payload, signal: new AbortController().signal });

describe("documents offers actions to agents", () => {
  it("declares two reads and one write, each behind a permission and a job it owns", () => {
    assert.doesNotThrow(() => validateManifest(documents));
    const actions = documents.actions ?? [];
    assert.deepEqual(actions.map((action) => [action.key, action.risk, action.permission]), [
      ["find_templates", "read", "documents.read"],
      ["count_documents", "read", "documents.read"],
      ["archive_template", "write", "documents.write"],
    ]);
    assert.ok((documents.jobs ?? []).some((job) => job.name === "archive_template"));
    assert.match(documents.platform, /^\^0\.1\.(5|[6-9]|\d{2,})$/, "asks for the SDK that has actions");
  });

  test("lists them in the platform's catalog", async () => {
    const refs = (await service.catalog()).filter((entry) => entry.moduleId === "documents").map((entry) => entry.ref);
    assert.deepEqual(refs, ["documents.find_templates", "documents.count_documents", "documents.archive_template"]);
  });

  test("reads the templates, all of them or by part of the name, and the documents by state", async () => {
    const all = await service.run({ moduleId: "documents", key: "find_templates" }, {}, agent);
    assert.deepEqual(all.kind === "rows" && all.rows.map((row) => row.name), ["NDA mutual", "Service contract"]);
    const some = await service.run({ moduleId: "documents", key: "find_templates" }, { q: "nda" }, agent);
    assert.deepEqual(some.kind === "rows" && some.rows.map((row) => row.slug), ["nda"]);
    const counts = await service.run({ moduleId: "documents", key: "count_documents" }, {}, agent);
    assert.equal(counts.kind, "rows");
  });

  test("archives a template only after a person approved the agent's proposal, and says what it did", async () => {
    const id = await idOf("nda");
    await assert.rejects(service.run({ moduleId: "documents", key: "archive_template" }, { template: id }, agent), (error: unknown) => error instanceof ActionError && error.code === "needs_approval");
    const proposal = await service.propose({ moduleId: "documents", key: "archive_template" }, { template: id }, agent);
    assert.equal(await archived("nda"), false, "nothing changes while it waits");
    await assert.rejects(service.approve(proposal.id, person("reader@example.test", ["documents.read"])), (error: unknown) => error instanceof ActionError && error.code === "forbidden");
    const approved = await service.approve(proposal.id, person("boss@example.test", ["documents.write"]));
    const job = (await pool!.query("select name, payload from core.jobs where id = $1", [approved.jobId])).rows[0];
    assert.deepEqual([job.name, job.payload], ["archive_template", { template: id }]);
    await archiveTemplateJob(ctx(job.payload));
    assert.equal(await archived("nda"), true);
    assert.equal(await archived("svc"), false, "only the one asked for");
    await pool!.query("update core.jobs set status = 'succeeded', finished_at = now() where id = $1", [approved.jobId]);
    assert.equal(await service.settle(), 1);
    assert.equal((await service.get(proposal.id))?.outcome, "executed");
  });

  test("the job is safe to run twice and refuses a payload that is not a template id", async () => {
    const id = await idOf("svc");
    await archiveTemplateJob(ctx({ template: id }));
    await archiveTemplateJob(ctx({ template: id }));
    assert.equal(await archived("svc"), true);
    for (const payload of [null, {}, { template: "1" }, { template: 0 }, { template: 1.5 }, { template: id, other: 1 }]) await assert.rejects(archiveTemplateJob(ctx(payload)), /template/, JSON.stringify(payload));
  });
});
