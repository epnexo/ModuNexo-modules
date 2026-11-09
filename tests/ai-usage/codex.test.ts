import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexCollector } from "../../modules/ai-usage/src/collectors/codex.ts";

const root = fileURLToPath(new URL("./fixtures/codex", import.meta.url));
const first = join(root, "2026/10/01/rollout-2026-10-01T10-00-00-cdx-0001.jsonl");
const forked = join(root, "2026/10/01/rollout-2026-10-01T11-00-00-cdx-0002.jsonl");
const collector = createCodexCollector({ root });
const fromStart = { offset: 0, state: null };

const file = (path: string) => ({ path, size: statSync(path).size, mtimeMs: 0 });

describe("Codex collector", () => {
  it("identifies the tool", () => {
    assert.equal(collector.toolId, "codex");
  });

  it("discovers rollout files recursively and ignores other files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-codex-"));
    try {
      writeFileSync(join(dir, "notes.jsonl"), "{}\n");
      writeFileSync(join(dir, "rollout-a.jsonl"), "{}\n");
      const files = await createCodexCollector({ root: dir }).discover();
      assert.deepEqual(files.map((f) => f.path), [join(dir, "rollout-a.jsonl")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual((await collector.discover()).map((f) => f.path), [first, forked]);
  });

  it("emits one event per distinct cumulative total and ignores repeated token_count lines", async () => {
    const { usage } = await collector.parse(file(first), fromStart);
    assert.deepEqual(usage.map((u) => u.externalId), ["cdx-0001:120", "cdx-0001:300"]);
  });

  it("normalizes counters: input excludes cached tokens, reasoning is a subset of output", async () => {
    const { usage } = await collector.parse(file(first), fromStart);
    const [a, b] = usage as [(typeof usage)[number], (typeof usage)[number]];
    assert.deepEqual(
      [a.inputTokens, a.cacheReadTokens, a.cacheWriteTokens, a.outputTokens, a.reasoningTokens, a.model],
      [40, 60, 0, 20, 8, "gpt-test-a"],
    );
    assert.deepEqual(
      [b.inputTokens, b.cacheReadTokens, b.outputTokens, b.reasoningTokens, b.model],
      [50, 100, 30, 2, "gpt-test-b"],
    );
    assert.equal(a.occurredAt.toISOString(), "2026-10-01T10:00:05.000Z");
    assert.equal(a.sessionExternalId, "cdx-0001");
  });

  it("uses the per-turn usage, so the sum of events equals the final cumulative total", async () => {
    const { usage } = await collector.parse(file(first), fromStart);
    const total = usage.reduce((sum, u) => sum + (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0), 0);
    assert.equal(total, 300);
  });

  it("builds the session and counters", async () => {
    const result = await collector.parse(file(first), fromStart);
    assert.equal(result.sessionExternalId, "cdx-0001");
    assert.deepEqual(result.counters, { messageCount: 1, toolCallCount: 1, durationMs: 5000 });
    const session = result.sessions[0]!;
    assert.equal(session.externalId, "cdx-0001");
    assert.equal(session.projectLabel, "demo-codex");
    assert.equal(session.startedAt.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(session.endedAt.toISOString(), "2026-10-01T10:01:05.000Z");
  });

  it("attributes a forked rollout to its own session and counts only the new usage", async () => {
    const result = await collector.parse(file(forked), fromStart);
    assert.deepEqual(result.sessions.map((s) => s.externalId), ["cdx-0002"]);
    assert.deepEqual(result.usage.map((u) => [u.externalId, u.sessionExternalId, u.inputTokens, u.cacheReadTokens, u.outputTokens]), [
      ["cdx-0002:1320", "cdx-0002", 50, 0, 10],
    ]);
  });

  it("never lets transcript text, tool arguments or instructions reach a parsed record", async () => {
    for (const path of [first, forked]) {
      const serialized = JSON.stringify(await collector.parse(file(path), fromStart));
      assert.doesNotMatch(serialized, /SECRET_/);
      assert.doesNotMatch(serialized, /\/work\//);
    }
  });

  it("stores null counters, not zeros, when a token_count only reports a grand total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-codex-"));
    try {
      const path = join(dir, "rollout-y.jsonl");
      const meta = '{"timestamp":"2026-10-01T10:00:00.000Z","type":"session_meta","payload":{"id":"cdx-0003","cwd":"/work/x"}}';
      const zeros = '{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":500}';
      const count = `{"timestamp":"2026-10-01T10:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":500},"last_token_usage":${zeros}}}}`;
      writeFileSync(path, `${meta}\n${count}\n`);
      const { usage } = await collector.parse(file(path), fromStart);
      assert.equal(usage.length, 1);
      assert.deepEqual(
        [usage[0]!.inputTokens, usage[0]!.cacheReadTokens, usage[0]!.cacheWriteTokens, usage[0]!.outputTokens, usage[0]!.reasoningTokens],
        [null, null, null, null, null],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes mid-file without re-emitting a repeated cumulative total or losing the model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-codex-"));
    try {
      const path = join(dir, "rollout-x.jsonl");
      const lines = readFileSync(first, "utf8").split("\n").filter(Boolean);
      // Split between the first token_count and its repeat.
      writeFileSync(path, `${lines.slice(0, 6).join("\n")}\n`);
      const one = await collector.parse(file(path), fromStart);
      writeFileSync(path, `${lines.join("\n")}\n`);
      const two = await collector.parse(file(path), { offset: one.offset, state: one.state });
      assert.deepEqual(one.usage.map((u) => u.externalId), ["cdx-0001:120"]);
      assert.deepEqual(two.usage.map((u) => u.externalId), ["cdx-0001:300"]);
      assert.equal(two.usage[0]!.model, "gpt-test-b");
      assert.equal(two.sessions[0]!.externalId, "cdx-0001");
      assert.equal(one.counters.durationMs + two.counters.durationMs, 5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can emit the same event key twice when a cumulative total comes back after a different one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-usage-codex-"));
    try {
      const path = join(dir, "rollout-x.jsonl");
      const tokenCount = (ts: string, cumulative: number) =>
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { total_tokens: cumulative },
              last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 },
            },
          },
        });
      const meta = JSON.stringify({ timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta", payload: { id: "dup-1", cwd: "/work/x" } });
      writeFileSync(path, [meta, tokenCount("2026-10-01T10:00:01.000Z", 100), tokenCount("2026-10-01T10:00:02.000Z", 200), tokenCount("2026-10-01T10:00:03.000Z", 100), ""].join("\n"));
      const { usage } = await collector.parse(file(path), fromStart);
      assert.deepEqual(usage.map((u) => u.externalId), ["dup-1:100", "dup-1:200", "dup-1:100"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
