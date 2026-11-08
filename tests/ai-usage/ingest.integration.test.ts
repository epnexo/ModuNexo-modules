import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool } from "@modunexo/core/pool";
import { Registry } from "@modunexo/core/registry";
import { migrate } from "@modunexo/core/runner";
import { createScratchDatabase } from "@modunexo/core/testing";
import aiUsage from "../../modules/ai-usage/manifest.ts";
import type pg from "pg";
import type { Collector, UsageRecord } from "../../modules/ai-usage/src/collector.ts";
import { createOpenCodeDb } from "./helpers/opencode-db.ts";
import { createClaudeCodeCollector } from "../../modules/ai-usage/src/collectors/claude-code.ts";
import { createCodexCollector } from "../../modules/ai-usage/src/collectors/codex.ts";
import { createOpenCodeCollector } from "../../modules/ai-usage/src/collectors/opencode.ts";
import { createPiCollector } from "../../modules/ai-usage/src/collectors/pi.ts";
import { ingest } from "../../modules/ai-usage/src/ingest.ts";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const MODULE_DIR = fileURLToPath(new URL("../../modules/ai-usage/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let scratchUrl: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let work: string;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  scratchUrl = scratch.url;
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(aiUsage);
  await migrate(pool, registry, { moduleDirs: { "ai-usage": MODULE_DIR } });
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("truncate ai_usage.usage_events, ai_usage.ingest_state, ai_usage.activity_items, ai_usage.sessions restart identity cascade");
  work = mkdtempSync(join(tmpdir(), "ai-usage-ingest-"));
  cpSync(join(fixtures, "claude"), join(work, "claude"), { recursive: true });
  cpSync(join(fixtures, "codex"), join(work, "codex"), { recursive: true });
  cpSync(join(fixtures, "pi"), join(work, "pi"), { recursive: true });
  mkdirSync(join(work, "opencode"));
  createOpenCodeDb(join(work, "opencode/opencode.db")).close();
});

const collectors = () => [
  createClaudeCodeCollector({ root: join(work, "claude/projects") }),
  createCodexCollector({ root: join(work, "codex") }),
];

const piAndOpenCode = () => [createPiCollector({ root: join(work, "pi/sessions") }), createOpenCodeCollector({ root: join(work, "opencode") })];

const test = (name: string, run: (t: TestContext) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    try {
      await run(t);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

const count = async (table: string) => Number((await pool!.query(`select count(*) from ai_usage.${table}`)).rows[0].count);
const byTool = (reports: Awaited<ReturnType<typeof ingest>>) => Object.fromEntries(reports.map((r) => [r.tool, r]));

describe("ingest (integration)", () => {
  test("inserts sessions and events and reports per-tool numbers", async () => {
    const reports = byTool(await ingest(pool!, collectors()));
    assert.deepEqual(
      [reports["claude-code"]!.filesScanned, reports["claude-code"]!.filesSkipped, reports["claude-code"]!.sessionsInserted, reports["claude-code"]!.eventsInserted, reports["claude-code"]!.tokensInserted],
      [2, 0, 1, 3, 1640],
    );
    assert.deepEqual(
      [reports.codex!.filesScanned, reports.codex!.sessionsInserted, reports.codex!.eventsInserted, reports.codex!.tokensInserted],
      [2, 2, 3, 360],
    );
    assert.equal(await count("usage_events"), 6);
    assert.equal(await count("sessions"), 3);
  });

  test("stores one row for a message that appears in two files", async () => {
    await ingest(pool!, collectors());
    const rows = await pool!.query("select count(*) from ai_usage.usage_events where external_id = 'msg_1:req_1'");
    assert.equal(Number(rows.rows[0].count), 1);
  });

  test("a second run skips unchanged files and inserts nothing", async () => {
    await ingest(pool!, collectors());
    const before = [await count("usage_events"), await count("sessions"), await count("ingest_state")];
    const second = await ingest(pool!, collectors());
    for (const report of second) {
      assert.equal(report.filesSkipped, report.filesScanned);
      assert.equal(report.eventsInserted, 0);
      assert.equal(report.sessionsInserted, 0);
    }
    assert.deepEqual([await count("usage_events"), await count("sessions"), await count("ingest_state")], before);
  });

  test("re-ingesting with the state wiped inserts no duplicate rows", async () => {
    await ingest(pool!, collectors());
    await pool!.query("truncate ai_usage.ingest_state");
    const again = await ingest(pool!, collectors());
    assert.equal(again.reduce((sum, r) => sum + r.eventsInserted + r.sessionsInserted, 0), 0);
    assert.equal(await count("usage_events"), 6);
  });

  test("reads only appended data and updates a message that kept streaming", async () => {
    await ingest(pool!, collectors());
    const claudeFile = join(work, "claude/projects/-work-demo-app/sess-0001.jsonl");
    const codexFile = join(work, "codex/2026/10/01/rollout-2026-10-01T10-00-00-cdx-0001.jsonl");
    appendFileSync(
      claudeFile,
      [
        '{"type":"assistant","sessionId":"sess-0001","cwd":"/work/demo-app","timestamp":"2026-10-01T10:00:09.000Z","requestId":"req_1","message":{"id":"msg_1","model":"claude-test-large","role":"assistant","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":1000,"output_tokens":90}}}',
        '{"type":"assistant","sessionId":"sess-0001","cwd":"/work/demo-app","timestamp":"2026-10-01T10:10:00.000Z","requestId":"req_4","message":{"id":"msg_4","model":"claude-test-small","role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{}}],"usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}}',
        "",
      ].join("\n"),
    );
    appendFileSync(
      codexFile,
      '{"timestamp":"2026-10-01T10:02:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":260,"cached_input_tokens":160,"cache_write_input_tokens":0,"output_tokens":60,"reasoning_output_tokens":10,"total_tokens":320},"last_token_usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":20}}}}\n',
    );

    const reports = byTool(await ingest(pool!, collectors()));
    assert.deepEqual([reports["claude-code"]!.filesSkipped, reports["claude-code"]!.eventsInserted, reports["claude-code"]!.tokensInserted], [1, 1, 10]);
    assert.deepEqual([reports.codex!.filesSkipped, reports.codex!.eventsInserted, reports.codex!.tokensInserted], [1, 1, 20]);

    const grown = await pool!.query("select output_tokens, total_tokens from ai_usage.usage_events where external_id = 'msg_1:req_1'");
    assert.deepEqual([grown.rows[0].output_tokens, grown.rows[0].total_tokens], ["90", "1300"]);

    const state = await pool!.query(
      `select s.message_count, s.tool_call_count, s.duration_ms from ai_usage.ingest_state s
       join ai_usage.sessions x on x.id = s.session_id where x.external_id = 'sess-0001' order by s.size_bytes desc limit 1`,
    );
    assert.deepEqual(state.rows[0], { message_count: 1, tool_call_count: 2, duration_ms: "4000" });
  });

  test("replaces the counters of a file that was rewritten instead of appended", async () => {
    await ingest(pool!, collectors());
    const codexFile = join(work, "codex/2026/10/01/rollout-2026-10-01T10-00-00-cdx-0001.jsonl");
    const lines = readFileSync(codexFile, "utf8").split("\n").filter(Boolean);
    writeFileSync(codexFile, `${lines.slice(0, 7).join("\n")}\n`);
    const reports = byTool(await ingest(pool!, collectors()));
    assert.equal(reports.codex!.eventsInserted, 0);
    const row = await pool!.query(
      "select message_count, tool_call_count, duration_ms from ai_usage.ingest_state s join ai_usage.sessions x on x.id = s.session_id where x.external_id = 'cdx-0001'",
    );
    assert.deepEqual(row.rows[0], { message_count: 1, tool_call_count: 1, duration_ms: "0" });
  });

  test("only runs the collectors it is given", async () => {
    await ingest(pool!, [createCodexCollector({ root: join(work, "codex") })]);
    assert.equal(await count("usage_events"), 3);
    const tools = await pool!.query("select distinct t.slug from ai_usage.usage_events e join ai_usage.tools t on t.id = e.tool_id");
    assert.deepEqual(tools.rows, [{ slug: "codex" }]);
  });

  test("stores no transcript text, tool input or output, or paths in any table", async () => {
    await ingest(pool!, collectors());
    let dump = "";
    for (const table of ["tools", "sessions", "usage_events", "ingest_state"]) {
      dump += JSON.stringify((await pool!.query(`select * from ai_usage.${table}`)).rows);
    }
    assert.doesNotMatch(dump, /SECRET_/);
    assert.doesNotMatch(dump, /\/work\/|ai-usage-ingest-/);
    const labels = await pool!.query("select distinct project_label from ai_usage.sessions order by 1");
    assert.deepEqual(labels.rows.map((r) => r.project_label), ["demo-app", "demo-codex", "forked"]);
  });

  test("daily_usage rolls up per day, tool and model", async () => {
    await ingest(pool!, collectors());
    const rows = await pool!.query(
      "select to_char(day, 'YYYY-MM-DD') as day, tool, model, events, total_tokens from ai_usage.daily_usage order by tool, model",
    );
    assert.deepEqual(rows.rows, [
      { day: "2026-10-01", tool: "claude-code", model: "claude-test-large", events: "1", total_tokens: "1250" },
      { day: "2026-10-01", tool: "claude-code", model: "claude-test-small", events: "2", total_tokens: "390" },
      { day: "2026-10-01", tool: "codex", model: "gpt-test-a", events: "2", total_tokens: "180" },
      { day: "2026-10-01", tool: "codex", model: "gpt-test-b", events: "1", total_tokens: "180" },
    ]);
  });

  test("session_summary exposes the model only when a session used a single one", async () => {
    await ingest(pool!, collectors());
    const rows = await pool!.query("select external_id, model, message_count, tool_call_count, total_tokens from ai_usage.session_summary order by external_id");
    assert.deepEqual(rows.rows, [
      { external_id: "cdx-0001", model: null, message_count: "1", tool_call_count: "1", total_tokens: "300" },
      { external_id: "cdx-0002", model: "gpt-test-a", message_count: "0", tool_call_count: "0", total_tokens: "60" },
      { external_id: "sess-0001", model: null, message_count: "1", tool_call_count: "1", total_tokens: "1640" },
    ]);
  });

  test("counts a prompt, tool call and turn once when a resumed log repeats them in another file", async () => {
    const dir = join(work, "claude/projects/-work-demo-app");
    copyFileSync(join(dir, "sess-0001.jsonl"), join(dir, "sess-0001-resumed.jsonl"));
    await ingest(pool!, collectors());
    const rows = await pool!.query("select message_count, tool_call_count, duration_ms from ai_usage.session_summary where external_id = 'sess-0001'");
    assert.deepEqual(rows.rows, [{ message_count: "1", tool_call_count: "1", duration_ms: "4000" }]);
    assert.equal(await count("usage_events"), 6);
  });

  test("keeps a file's activity counters exact when it is re-read from the start", async () => {
    await ingest(pool!, collectors());
    const before = await pool!.query("select source_key, message_count, tool_call_count, duration_ms from ai_usage.ingest_state order by source_key");
    // A rewritten (shrunk) Claude file is read again from the start; its own items already exist.
    const file = join(work, "claude/projects/-work-demo-app/sess-0001.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, `${lines.slice(0, 9).join("\n")}\n`);
    await ingest(pool!, collectors());
    const after = await pool!.query("select source_key, message_count, tool_call_count, duration_ms from ai_usage.ingest_state order by source_key");
    assert.deepEqual(after.rows, before.rows);
  });

  test("keeps going when one file cannot be read and reports it without its path", async () => {
    const real = createCodexCollector({ root: join(work, "codex") });
    const broken: Collector = {
      ...real,
      discover: async () => [...(await real.discover()), { path: join(work, "codex/vanished-rollout.jsonl"), size: 10, mtimeMs: 1 }],
    };
    const [report] = await ingest(pool!, [broken]);
    assert.equal(report!.filesScanned, 3);
    assert.equal(report!.filesFailed, 1);
    assert.equal(report!.eventsInserted, 3);
    assert.equal(report!.failedFiles.length, 1);
    assert.match(report!.failedFiles[0]!.id, /^codex:[0-9a-f]{12}$/);
    assert.doesNotMatch(JSON.stringify(report), /vanished|\/tmp\//);
  });

  test("a failed file is retried on the next run", async () => {
    const real = createCodexCollector({ root: join(work, "codex") });
    const ghost = { path: join(work, "codex/late-rollout.jsonl"), size: 10, mtimeMs: 1 };
    const withGhost: Collector = { ...real, discover: async () => [...(await real.discover()), ghost] };
    assert.equal((await ingest(pool!, [withGhost]))[0]!.filesFailed, 1);
    assert.equal((await ingest(pool!, [withGhost]))[0]!.filesFailed, 1);
    assert.equal(await count("ingest_state"), 2);
  });

  test("the ingest command exits non-zero and names failed files by tool and key only", async (t) => {
    const url = scratchUrl;
    if (!url || process.getuid?.() === 0) return t.skip("needs a test database and a non-root user to make a file unreadable");
    const dir = join(work, "cli-codex");
    cpSync(join(fixtures, "codex"), dir, { recursive: true });
    const locked = join(dir, "2026/10/01/rollout-2026-10-01T10-00-00-cdx-0001.jsonl");
    chmodSync(locked, 0o000);
    try {
      const run = spawnSync(process.execPath, ["--import", "tsx", join(MODULE_DIR, "src/cli/ingest.ts"), "--tool", "codex", "--codex-dir", dir], {
        env: { ...process.env, DATABASE_URL: url },
        encoding: "utf8",
      });
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stdout, /files failed 1/);
      assert.match(run.stdout, /failed: codex:[0-9a-f]{12}/);
      assert.doesNotMatch(run.stdout + run.stderr, /rollout-|\/tmp\//);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("stores one event when a collector reports the same event key twice in one batch", async () => {
    const event = (output: number): UsageRecord => ({
      externalId: "dup:1",
      sessionExternalId: "dup",
      occurredAt: new Date("2026-10-01T10:00:00.000Z"),
      model: "m",
      inputTokens: 1,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: output,
      reasoningTokens: null,
    });
    const stub: Collector = {
      toolId: "codex",
      toolName: "Codex",
      discover: async () => [{ path: join(work, "stub"), size: 1, mtimeMs: 1 }],
      parse: async () => ({
        sessions: [{ externalId: "dup", startedAt: new Date("2026-10-01T10:00:00.000Z"), endedAt: new Date("2026-10-01T10:00:00.000Z"), projectLabel: null }],
        usage: [event(5), event(9)],
        counters: { messageCount: 0, toolCallCount: 0, durationMs: 0 },
        sessionExternalId: "dup",
        offset: 1,
        state: null,
      }),
    };
    const [report] = await ingest(pool!, [stub]);
    assert.equal(report!.filesFailed, 0);
    assert.equal(report!.eventsInserted, 1);
    const rows = await pool!.query("select output_tokens from ai_usage.usage_events where external_id = 'dup:1'");
    assert.deepEqual(rows.rows, [{ output_tokens: "9" }]);
  });

  test("ingests Pi sessions, rolling a subagent run into its parent, and stays idempotent", async () => {
    const [pi] = await ingest(pool!, [createPiCollector({ root: join(work, "pi/sessions") })]);
    assert.deepEqual([pi!.filesScanned, pi!.sessionsInserted, pi!.eventsInserted, pi!.tokensInserted], [2, 1, 4, 1199]);
    const summary = await pool!.query("select external_id, project_label, events, message_count, tool_call_count, duration_ms, total_tokens from ai_usage.session_summary where tool = 'pi'");
    assert.deepEqual(summary.rows, [{ external_id: "pi-0001", project_label: "demo-pi", events: "4", message_count: "1", tool_call_count: "3", duration_ms: "0", total_tokens: "1199" }]);
    const nulls = await pool!.query("select count(*) from ai_usage.usage_events where input_tokens is null and output_tokens is null");
    assert.equal(Number(nulls.rows[0].count), 1);

    const [again] = await ingest(pool!, [createPiCollector({ root: join(work, "pi/sessions") })]);
    assert.deepEqual([again!.filesSkipped, again!.eventsInserted, again!.sessionsInserted], [2, 0, 0]);
  });

  test("ingests OpenCode from its database, picks up later rows and never duplicates", async () => {
    const [first] = await ingest(pool!, [createOpenCodeCollector({ root: join(work, "opencode") })]);
    assert.deepEqual([first!.filesScanned, first!.sessionsInserted, first!.eventsInserted, first!.tokensInserted], [1, 1, 4, 1230]);
    const summary = await pool!.query("select external_id, project_label, events, message_count, tool_call_count, total_tokens from ai_usage.session_summary where tool = 'opencode'");
    assert.deepEqual(summary.rows, [{ external_id: "ses_root", project_label: "demo-oc", events: "4", message_count: "1", tool_call_count: "2", total_tokens: "1230" }]);

    const [unchanged] = await ingest(pool!, [createOpenCodeCollector({ root: join(work, "opencode") })]);
    assert.deepEqual([unchanged!.filesSkipped, unchanged!.eventsInserted], [1, 0]);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(work, "opencode/opencode.db"));
    const later = Date.parse("2026-10-03T09:00:00.000Z");
    db.prepare("insert into message values (?, ?, ?, ?, ?)").run("msg_a6", "ses_root", later, later + 1000, JSON.stringify({ role: "assistant", modelID: "model-a", time: { created: later }, tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
    db.prepare("insert into part values (?, ?, ?, ?, ?, ?)").run("prt_t3", "msg_a6", "ses_root", later, later + 500, JSON.stringify({ type: "tool", state: { input: "SECRET" } }));
    db.close();

    const [grown] = await ingest(pool!, [createOpenCodeCollector({ root: join(work, "opencode") })]);
    assert.deepEqual([grown!.filesSkipped, grown!.eventsInserted, grown!.tokensInserted], [0, 1, 4]);
    const after = await pool!.query("select events, tool_call_count, message_count from ai_usage.session_summary where tool = 'opencode'");
    assert.deepEqual(after.rows, [{ events: "5", tool_call_count: "3", message_count: "1" }]);
  });

  test("keeps transcript text, tool data and paths of Pi and OpenCode out of every table", async () => {
    await ingest(pool!, piAndOpenCode());
    let dump = "";
    for (const table of ["tools", "sessions", "usage_events", "ingest_state", "activity_items"]) {
      dump += JSON.stringify((await pool!.query(`select * from ai_usage.${table}`)).rows);
    }
    assert.doesNotMatch(dump, /SECRET_/);
    assert.doesNotMatch(dump, /\/work\/|ai-usage-ingest-/);
    const models = await pool!.query("select distinct model from ai_usage.usage_events order by 1");
    assert.deepEqual(models.rows.map((r) => r.model), ["model-a", "model-b", "model-c", "vendor/model-b"]);
  });
});
