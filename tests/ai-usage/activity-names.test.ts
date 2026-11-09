import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ActivityItem } from "../../modules/ai-usage/src/collector.ts";
import { createClaudeCodeCollector } from "../../modules/ai-usage/src/collectors/claude-code.ts";
import { createCodexCollector } from "../../modules/ai-usage/src/collectors/codex.ts";
import { createOpenCodeCollector } from "../../modules/ai-usage/src/collectors/opencode.ts";
import { createPiCollector } from "../../modules/ai-usage/src/collectors/pi.ts";
import { batchInput } from "../../modules/ai-usage/lib/remote.ts";
import { createOpenCodeDb } from "./helpers/opencode-db.ts";

const fromStart = { offset: 0, state: null };
let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-usage-names-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return { path, size: statSync(path).size, mtimeMs: 0 };
};
const byId = (items: ActivityItem[] | undefined, id: string) => items?.find((item) => item.externalId.endsWith(id));

describe("Claude Code tool and skill names", () => {
  it("keeps the tool name, the skill of a Skill call and whether the call failed, and nothing of its input", async () => {
    const root = join(dir, "claude");
    const base = { sessionId: "s1", cwd: "/work/demo", timestamp: "2026-10-01T10:00:00.000Z" };
    const file = write(
      join(root, "-work-demo", "s1.jsonl"),
      lines(
        { type: "assistant", uuid: "a1", ...base, message: { id: "m1", model: "model-a", content: [
          { type: "tool_use", id: "tu1", name: "Skill", input: { skill: "demo-skill", args: "SECRET_ARGS" } },
          { type: "tool_use", id: "tu2", name: "Bash", input: { command: "SECRET_CMD /home/user/file" } },
        ] } },
        { type: "user", uuid: "u1", ...base, message: { content: [
          { type: "tool_result", tool_use_id: "tu1", content: "SECRET_OUT", is_error: false },
          { type: "tool_result", tool_use_id: "tu2", content: "SECRET_OUT", is_error: true },
        ] } },
      ),
    );
    const parsed = await createClaudeCodeCollector({ root }).parse(file, fromStart);
    const skill = byId(parsed.activity, "tu1");
    const bash = byId(parsed.activity, "tu2");
    assert.deepEqual([skill?.name, skill?.skill, skill?.failed], ["Skill", "demo-skill", false]);
    assert.deepEqual([bash?.name, bash?.skill, bash?.failed], ["Bash", null, true]);
    assert.doesNotMatch(JSON.stringify(parsed), /SECRET|\/home\/user/);
  });

  it("reports a result that arrives in a later read without counting the call twice", async () => {
    const root = join(dir, "claude-late");
    const base = { sessionId: "s1", cwd: "/work/demo", timestamp: "2026-10-01T10:00:00.000Z" };
    const file = write(
      join(root, "-work-demo", "s1.jsonl"),
      lines({ type: "user", uuid: "u1", ...base, message: { content: [{ type: "tool_result", tool_use_id: "tu9", content: "x", is_error: true }] } }),
    );
    const parsed = await createClaudeCodeCollector({ root }).parse(file, fromStart);
    assert.equal(parsed.counters.toolCallCount, 0);
    assert.equal(byId(parsed.activity, "tu9")?.failed, true);
    assert.equal(byId(parsed.activity, "tu9")?.name ?? null, null);
  });
});

describe("Codex activity", () => {
  const meta = { timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta", payload: { id: "cdx-1", timestamp: "2026-10-01T10:00:00.000Z", cwd: "/work/demo" } };
  const at = (n: number) => `2026-10-01T10:00:0${n}.000Z`;

  it("emits prompts, tool calls with their names and turns, and infers a skill only from a SKILL.md path", async () => {
    const root = join(dir, "codex");
    const file = write(
      join(root, "rollout-a.jsonl"),
      lines(
        meta,
        { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: "SECRET_PROMPT" } },
        { timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat /home/user/.agents/skills/demo-skill/SKILL.md SECRET" }), call_id: "c1" } },
        { timestamp: at(3), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat /home/user/.agents/skills/_shared/SKILL.md" }), call_id: "c2" } },
        { timestamp: at(4), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "SECRET_PATCH", call_id: "c3" } },
        { timestamp: at(5), type: "event_msg", payload: { type: "task_complete", turn_id: "t1", duration_ms: 5000 } },
      ),
    );
    const parsed = await createCodexCollector({ root }).parse(file, fromStart);
    const kinds = (parsed.activity ?? []).map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["prompt", "tool_call", "tool_call", "tool_call", "turn"]);
    assert.deepEqual([byId(parsed.activity, "c1")?.name, byId(parsed.activity, "c1")?.skill], ["exec_command", "demo-skill"]);
    assert.equal(byId(parsed.activity, "c2")?.skill ?? null, null, "a folder starting with an underscore is not a skill");
    assert.deepEqual([byId(parsed.activity, "c3")?.name, byId(parsed.activity, "c3")?.skill ?? null], ["apply_patch", null]);
    assert.equal(byId(parsed.activity, "c1")?.failed ?? null, null, "Codex does not say whether a call failed");
    assert.equal(byId(parsed.activity, "t1")?.durationMs, 5000);
    assert.deepEqual([parsed.counters.messageCount, parsed.counters.toolCallCount, parsed.counters.durationMs], [1, 3, 5000]);
    assert.doesNotMatch(JSON.stringify(parsed), /SECRET|\/home\/user/);
  });
});

describe("Pi tool and skill names", () => {
  it("keeps the tool name, infers a skill from a SKILL.md read and keeps the error flag", async () => {
    const root = join(dir, "pi");
    const file = write(
      join(root, "s", "a.jsonl"),
      lines(
        { type: "session", version: 3, id: "pi-1", timestamp: "2026-10-02T09:00:00.000Z", cwd: "/work/demo" },
        { type: "message", id: "e1", timestamp: "2026-10-02T09:00:10.000Z", message: { role: "assistant", content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/home/user/.agents/skills/demo-skill/SKILL.md" } },
          { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "SECRET_CMD" } },
        ] } },
        { type: "message", id: "r1", timestamp: "2026-10-02T09:00:11.000Z", message: { role: "toolResult", toolCallId: "call_2", toolName: "bash", content: [{ type: "text", text: "SECRET_OUT" }], isError: true } },
      ),
    );
    const parsed = await createPiCollector({ root }).parse(file, fromStart);
    assert.deepEqual([byId(parsed.activity, "call_1")?.name, byId(parsed.activity, "call_1")?.skill], ["read", "demo-skill"]);
    assert.deepEqual([byId(parsed.activity, "call_2")?.name, byId(parsed.activity, "call_2")?.failed], ["bash", true]);
    assert.doesNotMatch(JSON.stringify(parsed), /SECRET|\/home\/user/);
  });
});

describe("OpenCode tool and skill names", () => {
  it("keeps the tool name, the name of a skill call and the status of each call", async () => {
    const root = join(dir, "opencode");
    mkdirSync(root);
    const db = createOpenCodeDb(join(root, "opencode.db"));
    const T = Date.parse("2026-10-03T08:00:00.000Z");
    const part = db.prepare("insert into part values (?, ?, ?, ?, ?, ?)");
    part.run("prt_s1", "msg_a1", "ses_root", T + 5_000, T + 5_500, JSON.stringify({ type: "tool", tool: "skill", state: { status: "completed", input: { name: "demo-skill" }, output: "SECRET_SKILL_BODY" } }));
    part.run("prt_e1", "msg_a1", "ses_root", T + 6_000, T + 6_500, JSON.stringify({ type: "tool", tool: "bash", state: { status: "error", input: { command: "SECRET_CMD" }, error: "SECRET_ERR" } }));
    db.close();
    const collector = createOpenCodeCollector({ root });
    const parsed = await collector.parse((await collector.discover())[0]!, fromStart);
    const skill = byId(parsed.activity, "prt_s1");
    const failing = byId(parsed.activity, "prt_e1");
    assert.deepEqual([skill?.name, skill?.skill, skill?.failed], ["skill", "demo-skill", false]);
    assert.deepEqual([failing?.name, failing?.skill ?? null, failing?.failed], ["bash", null, true]);
    assert.equal(byId(parsed.activity, "prt_t1")?.name, "bash");
    assert.doesNotMatch(JSON.stringify(parsed), /SECRET/);
  });
});

describe("remote batch with names", () => {
  const body = (item: Record<string, unknown>) => ({ tool: { slug: "claude-code", name: "Claude Code" }, activity: [{ kind: "tool_call", externalId: "t1", sessionExternalId: null, ...item }] });

  it("accepts a tool name, a skill and a failure flag, and keeps them null when absent", () => {
    const checked = batchInput(body({ name: "Skill", skill: "demo-skill", failed: false }));
    assert.ok(checked.ok);
    assert.deepEqual([checked.value.activity[0]!.name, checked.value.activity[0]!.skill, checked.value.activity[0]!.failed], ["Skill", "demo-skill", false]);
    const bare = batchInput(body({}));
    assert.ok(bare.ok);
    assert.deepEqual([bare.value.activity[0]!.name, bare.value.activity[0]!.skill, bare.value.activity[0]!.failed], [null, null, null]);
  });

  it("refuses a name that looks like a path or is too long, and a failure flag that is not a boolean", () => {
    const error = (item: Record<string, unknown>) => {
      const checked = batchInput(body(item));
      return checked.ok ? undefined : checked.error;
    };
    assert.match(error({ name: "/home/user/secret" })!, /activity\[0\]\.name/);
    assert.match(error({ skill: "a/b" })!, /activity\[0\]\.skill/);
    assert.match(error({ name: "x".repeat(101) })!, /activity\[0\]\.name/);
    assert.match(error({ failed: "yes" })!, /activity\[0\]\.failed/);
  });
});
