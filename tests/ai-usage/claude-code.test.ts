import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createClaudeCodeCollector } from "../../modules/ai-usage/src/collectors/claude-code.ts";

const root = fileURLToPath(new URL("./fixtures/claude/projects", import.meta.url));
const main = join(root, "-work-demo-app", "sess-0001.jsonl");
const sub = join(root, "-work-demo-app", "sess-0001", "subagents", "agent-x.jsonl");
const collector = createClaudeCodeCollector({ root });
const fromStart = { offset: 0, state: null };

async function parse(path: string) {
  const info = statSync(path);
  return collector.parse({ path, size: info.size, mtimeMs: info.mtimeMs }, fromStart);
}

describe("Claude Code collector", () => {
  it("identifies the tool", () => {
    assert.equal(collector.toolId, "claude-code");
  });

  it("discovers every jsonl file under the root, including subagent logs, in a stable order", async () => {
    const files = await collector.discover();
    assert.deepEqual(files.map((f) => f.path), [main, sub]);
    assert.equal(files[0]!.size, statSync(main).size);
  });

  it("returns no files for a root that does not exist", async () => {
    assert.deepEqual(await createClaudeCodeCollector({ root: join(root, "missing") }).discover(), []);
  });

  it("merges repeated lines of one message into a single event using the largest counters", async () => {
    const result = await parse(main);
    const first = result.usage.find((u) => u.externalId === "msg_1:req_1");
    assert.ok(first);
    assert.equal(result.usage.filter((u) => u.externalId === "msg_1:req_1").length, 1);
    assert.deepEqual(
      [first.inputTokens, first.cacheReadTokens, first.cacheWriteTokens, first.outputTokens, first.reasoningTokens],
      [10, 1000, 200, 40, 3],
    );
    assert.equal(first.model, "claude-test-large");
    assert.equal(first.sessionExternalId, "sess-0001");
    assert.equal(first.occurredAt.toISOString(), "2026-10-01T10:00:02.000Z");
  });

  it("leaves reasoning tokens null when the log does not report them, and skips synthetic messages", async () => {
    const result = await parse(main);
    assert.deepEqual(result.usage.map((u) => u.externalId), ["msg_1:req_1", "msg_2:req_2"]);
    const second = result.usage[1]!;
    assert.equal(second.reasoningTokens, null);
    assert.equal(second.cacheWriteTokens, 0);
  });

  it("builds the session with its time span and the project directory basename", async () => {
    const { sessions } = await parse(main);
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.externalId, "sess-0001");
    assert.equal(session.projectLabel, "demo-app");
    assert.equal(session.startedAt.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(session.endedAt.toISOString(), "2026-10-01T10:06:00.000Z");
  });

  it("counts prompts, tool calls and turn durations without counting tool results or sidechains", async () => {
    const main_ = await parse(main);
    assert.deepEqual(main_.counters, { messageCount: 1, toolCallCount: 1, durationMs: 4000 });
    assert.equal(main_.sessionExternalId, "sess-0001");
    const sub_ = await parse(sub);
    assert.deepEqual(sub_.counters, { messageCount: 0, toolCallCount: 0, durationMs: 0 });
  });

  it("reports prompts, tool calls and turns as items keyed by the tool's own ids", async () => {
    const { activity } = await parse(main);
    assert.deepEqual(activity, [
      { kind: "prompt", externalId: "u1", sessionExternalId: "sess-0001", durationMs: 0 },
      { kind: "tool_call", externalId: "toolu_1", sessionExternalId: "sess-0001", durationMs: 0 },
      { kind: "turn", externalId: "sess-0001:2026-10-01T10:00:06.000Z", sessionExternalId: "sess-0001", durationMs: 4000 },
    ]);
    assert.deepEqual((await parse(sub)).activity, []);
  });

  it("reports the same message from another file with the same key so ingestion can dedupe it", async () => {
    const result = await parse(sub);
    assert.deepEqual(result.usage.map((u) => u.externalId).sort(), ["msg_1:req_1", "msg_9:req_9"]);
  });

  it("never lets transcript text, tool input or output reach a parsed record", async () => {
    for (const path of [main, sub]) {
      const serialized = JSON.stringify(await parse(path));
      assert.doesNotMatch(serialized, /SECRET_/);
      assert.doesNotMatch(serialized, /\/work\//, "only the directory basename may be kept");
    }
  });

  it("consumes only complete lines and resumes from the returned offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-claude-"));
    try {
      const path = join(dir, "s.jsonl");
      const lines = readFileSync(main, "utf8").split("\n").filter(Boolean);
      const firstChunk = `${lines.slice(0, 4).join("\n")}\n{"type":"assistant","sessionId":"sess-0001","times`;
      writeFileSync(path, firstChunk);
      const one = await collector.parse({ path, size: statSync(path).size, mtimeMs: 0 }, fromStart);
      const completeBytes = Buffer.byteLength(lines.slice(0, 4).join("\n") + "\n");
      assert.equal(one.offset, completeBytes);

      writeFileSync(path, lines.join("\n") + "\n");
      const two = await collector.parse({ path, size: statSync(path).size, mtimeMs: 0 }, { offset: one.offset, state: one.state });
      assert.equal(two.offset, statSync(path).size);
      // msg_1 straddles both chunks; msg_2 only appears in the second.
      assert.deepEqual(two.usage.map((u) => u.externalId).sort(), ["msg_1:req_1", "msg_2:req_2"]);
      assert.equal(two.usage.find((u) => u.externalId === "msg_1:req_1")!.outputTokens, 40);
      assert.equal(one.counters.messageCount + two.counters.messageCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
