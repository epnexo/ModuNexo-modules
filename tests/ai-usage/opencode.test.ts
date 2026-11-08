import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createOpenCodeCollector } from "../../modules/ai-usage/src/collectors/opencode.ts";
import { createOpenCodeDb, OPENCODE_T0 } from "./helpers/opencode-db.ts";

let dir: string;
let dbPath: string;
let collector: ReturnType<typeof createOpenCodeCollector>;
const fromStart = { offset: 0, state: null };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-usage-opencode-"));
  dbPath = join(dir, "opencode.db");
  createOpenCodeDb(dbPath).close();
  collector = createOpenCodeCollector({ root: dir });
});

after(() => rmSync(dir, { recursive: true, force: true }));

const parse = async () => collector.parse((await collector.discover())[0]!, fromStart);

describe("OpenCode collector", () => {
  it("identifies the tool", () => {
    assert.equal(collector.toolId, "opencode");
    assert.equal(collector.toolName, "OpenCode");
  });

  it("discovers the database as one source and returns nothing when it does not exist", async () => {
    const files = await collector.discover();
    assert.deepEqual(files.map((f) => f.path), [dbPath]);
    assert.deepEqual(await createOpenCodeCollector({ root: join(dir, "missing") }).discover(), []);
  });

  it("reports changes that are still in the write-ahead log by adding its size and newest mtime to the source", async () => {
    const wal = `${dbPath}-wal`;
    const base = statSync(dbPath);
    try {
      writeFileSync(wal, Buffer.alloc(4096));
      const future = new Date(base.mtimeMs + 60_000);
      utimesSync(wal, future, future);
      const [file] = await collector.discover();
      assert.equal(file!.size, base.size + 4096);
      assert.equal(file!.mtimeMs, Math.trunc(future.getTime()));
    } finally {
      rmSync(wal, { force: true });
    }
  });

  it("emits one event per assistant message keyed by its message id, with the model as the log reports it", async () => {
    const { usage } = await parse();
    assert.deepEqual(usage.map((u) => u.externalId).sort(), ["msg_a1", "msg_a2", "msg_a4", "msg_a5"]);
    assert.deepEqual(usage.map((u) => u.model).sort(), ["model-a", "model-a", "model-c", "vendor/model-b"]);
    assert.equal(usage.find((u) => u.externalId === "msg_a1")!.occurredAt.toISOString(), "2026-10-03T08:00:02.000Z");
  });

  it("folds reasoning into output so totals match the log, and keeps reasoning as the informational part", async () => {
    const a1 = (await parse()).usage.find((u) => u.externalId === "msg_a1")!;
    assert.deepEqual(
      [a1.inputTokens, a1.cacheReadTokens, a1.cacheWriteTokens, a1.outputTokens, a1.reasoningTokens],
      [100, 1000, 20, 80, 30],
    );
    const total = (a1.inputTokens ?? 0) + (a1.cacheReadTokens ?? 0) + (a1.cacheWriteTokens ?? 0) + (a1.outputTokens ?? 0);
    assert.equal(total, 1200, "equals the total the log reports");
  });

  it("stores nulls for a message with no token data and skips a response that used nothing", async () => {
    const { usage } = await parse();
    assert.equal(usage.find((u) => u.externalId === "msg_a3"), undefined);
    const a4 = usage.find((u) => u.externalId === "msg_a4")!;
    assert.deepEqual([a4.inputTokens, a4.cacheReadTokens, a4.cacheWriteTokens, a4.outputTokens, a4.reasoningTokens], [null, null, null, null, null]);
  });

  it("rolls child sessions into their root session and labels it with the directory basename", async () => {
    const { sessions, usage, sessionExternalId } = await parse();
    assert.equal(sessionExternalId, null, "a database holds many sessions, so no single one belongs to the source");
    assert.deepEqual(sessions.map((s) => s.externalId), ["ses_root"]);
    assert.equal(sessions[0]!.projectLabel, "demo-oc");
    assert.equal(sessions[0]!.startedAt.toISOString(), "2026-10-03T08:00:00.000Z");
    assert.equal(sessions[0]!.endedAt.toISOString(), "2026-10-03T08:10:00.000Z");
    assert.ok(usage.every((u) => u.sessionExternalId === "ses_root"));
  });

  it("reports user prompts of root sessions and every tool call as items, with no durations", async () => {
    const { activity, counters } = await parse();
    assert.deepEqual(activity, [
      { kind: "prompt", externalId: "msg_u1", sessionExternalId: "ses_root", durationMs: 0 },
      { kind: "tool_call", externalId: "prt_t1", sessionExternalId: "ses_root", durationMs: 0 },
      { kind: "tool_call", externalId: "prt_t2", sessionExternalId: "ses_root", durationMs: 0 },
    ]);
    assert.deepEqual(counters, { messageCount: 1, toolCallCount: 2, durationMs: 0 });
  });

  it("never lets titles, text, tool input or output, or paths reach a parsed record", async () => {
    const serialized = JSON.stringify(await parse());
    assert.doesNotMatch(serialized, /SECRET_/);
    assert.doesNotMatch(serialized, /\/work\//, "only the directory basename may be kept");
  });

  it("opens the database read-only and leaves it unchanged", async () => {
    const before = sha(dbPath);
    await parse();
    assert.equal(sha(dbPath), before);
  });

  it("reads only rows changed since the last run and sees a message that kept growing", async () => {
    const first = await parse();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      const later = OPENCODE_T0 + 900_000;
      db.prepare("insert into message values (?, ?, ?, ?, ?)").run(
        "msg_a6", "ses_root", later, later + 1_000,
        JSON.stringify({ role: "assistant", modelID: "model-a", time: { created: later, completed: later + 900 }, tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }),
      );
      db.prepare("update message set time_updated = ?, data = ? where id = 'msg_a5'").run(
        later + 2_000,
        JSON.stringify({ role: "assistant", modelID: "model-a", time: { created: OPENCODE_T0 + 32_000, completed: later }, tokens: { input: 4, output: 9, reasoning: 1, cache: { read: 8, write: 0 } } }),
      );
    } finally {
      db.close();
    }
    const second = await collector.parse((await collector.discover())[0]!, { offset: first.offset, state: first.state });
    // msg_a4 was the newest row of the first read and is read again (rows at the watermark are not skipped).
    assert.deepEqual(second.usage.map((u) => u.externalId).sort(), ["msg_a4", "msg_a5", "msg_a6"]);
    assert.equal(second.usage.find((u) => u.externalId === "msg_a5")!.outputTokens, 10);
    assert.deepEqual(second.activity, []);
  });
});
