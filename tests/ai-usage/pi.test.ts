import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createPiCollector } from "../../modules/ai-usage/src/collectors/pi.ts";

const root = fileURLToPath(new URL("./fixtures/pi/sessions", import.meta.url));
const project = join(root, "--work-demo-pi--");
const main = join(project, "2026-10-02T09-00-00-000Z_pi-0001.jsonl");
const sub = join(project, "2026-10-02T09-00-00-000Z_pi-0001/ab12cd34/run-0/session.jsonl");
const collector = createPiCollector({ root });
const fromStart = { offset: 0, state: null };

const parse = (path: string) => collector.parse({ path, size: statSync(path).size, mtimeMs: 0 }, fromStart);

describe("Pi collector", () => {
  it("identifies the tool", () => {
    assert.equal(collector.toolId, "pi");
    assert.equal(collector.toolName, "Pi");
  });

  it("discovers session files, including subagent runs, in a stable order", async () => {
    assert.deepEqual((await collector.discover()).map((f) => f.path), [main, sub]);
    assert.deepEqual(await createPiCollector({ root: join(root, "missing") }).discover(), []);
  });

  it("emits one event per assistant message with the counters as the log reports them", async () => {
    const { usage } = await parse(main);
    assert.deepEqual(usage.map((u) => u.externalId), ["pi-0001:e0000001", "pi-0001:e0000002", "pi-0001:e0000004"]);
    const [first, second] = usage as [(typeof usage)[number], (typeof usage)[number]];
    assert.deepEqual(
      [first.inputTokens, first.cacheReadTokens, first.cacheWriteTokens, first.outputTokens, first.reasoningTokens, first.model],
      [100, 1000, 20, 50, 30, "model-a"],
    );
    assert.equal(first.occurredAt.toISOString(), "2026-10-02T09:00:10.000Z");
    assert.equal(first.sessionExternalId, "pi-0001");
    assert.deepEqual([second.inputTokens, second.outputTokens, second.reasoningTokens, second.model], [10, 5, null, "model-b"]);
  });

  it("stores nulls, never zeros or estimates, for a message without usage, and skips a response that used nothing", async () => {
    const { usage } = await parse(main);
    assert.equal(usage.find((u) => u.externalId === "pi-0001:e0000003"), undefined, "an all-zero error response is not an event");
    const unknown = usage.find((u) => u.externalId === "pi-0001:e0000004")!;
    assert.deepEqual(
      [unknown.inputTokens, unknown.cacheReadTokens, unknown.cacheWriteTokens, unknown.outputTokens, unknown.reasoningTokens, unknown.model],
      [null, null, null, null, null, "model-c"],
    );
  });

  it("builds the session from the header with its time span and the project directory basename", async () => {
    const { sessions, sessionExternalId } = await parse(main);
    assert.equal(sessionExternalId, "pi-0001");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.externalId, "pi-0001");
    assert.equal(sessions[0]!.projectLabel, "demo-pi");
    assert.equal(sessions[0]!.startedAt.toISOString(), "2026-10-02T09:00:00.000Z");
    assert.equal(sessions[0]!.endedAt.toISOString(), "2026-10-02T09:09:00.000Z");
  });

  it("attributes a subagent run to its parent session but keeps its event keys unique", async () => {
    const { sessions, usage, sessionExternalId, activity } = await parse(sub);
    assert.equal(sessionExternalId, "pi-0001");
    assert.deepEqual(sessions.map((s) => s.externalId), ["pi-0001"]);
    assert.deepEqual(usage.map((u) => u.externalId), ["pi-sub-0001:e0000001"]);
    assert.equal(usage[0]!.sessionExternalId, "pi-0001");
    // The task handed to a subagent is not a prompt typed by the user.
    assert.deepEqual(activity, [{ kind: "tool_call", externalId: "pi-sub-0001:call_1", sessionExternalId: "pi-0001", durationMs: 0 }]);
  });

  it("reports prompts and tool calls as items and a duration of zero, since the log has no turn durations", async () => {
    const { activity, counters } = await parse(main);
    assert.deepEqual(activity, [
      { kind: "prompt", externalId: "pi-0001:u0000001", sessionExternalId: "pi-0001", durationMs: 0 },
      { kind: "tool_call", externalId: "pi-0001:call_1", sessionExternalId: "pi-0001", durationMs: 0 },
      { kind: "tool_call", externalId: "pi-0001:call_2", sessionExternalId: "pi-0001", durationMs: 0 },
    ]);
    assert.deepEqual(counters, { messageCount: 1, toolCallCount: 2, durationMs: 0 });
  });

  it("never lets transcript text, tool input or output, or paths reach a parsed record", async () => {
    for (const path of [main, sub]) {
      const serialized = JSON.stringify(await parse(path));
      assert.doesNotMatch(serialized, /SECRET_/);
      assert.doesNotMatch(serialized, /\/work\//, "only the directory basename may be kept");
    }
  });

  it("consumes only complete lines and resumes from the returned offset and state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-pi-"));
    try {
      const path = join(dir, "s.jsonl");
      const lines = readFileSync(main, "utf8").split("\n").filter(Boolean);
      writeFileSync(path, `${lines.slice(0, 5).join("\n")}\n{"type":"message","id":"e00`);
      const one = await collector.parse({ path, size: statSync(path).size, mtimeMs: 0 }, fromStart);
      assert.equal(one.offset, Buffer.byteLength(`${lines.slice(0, 5).join("\n")}\n`));
      assert.deepEqual(one.usage.map((u) => u.externalId), ["pi-0001:e0000001"]);

      writeFileSync(path, `${lines.join("\n")}\n`);
      const two = await collector.parse({ path, size: statSync(path).size, mtimeMs: 0 }, { offset: one.offset, state: one.state });
      assert.equal(two.offset, statSync(path).size);
      assert.deepEqual(two.usage.map((u) => u.externalId), ["pi-0001:e0000002", "pi-0001:e0000004"]);
      assert.equal(two.sessions[0]!.startedAt.toISOString(), "2026-10-02T09:00:00.000Z");
      assert.equal(two.sessions[0]!.projectLabel, "demo-pi");
      assert.equal(two.usage[0]!.model, "model-b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
