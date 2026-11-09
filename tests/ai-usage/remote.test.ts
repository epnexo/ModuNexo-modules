import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchInput } from "../../modules/ai-usage/lib/remote.ts";

const session = { externalId: "s1", startedAt: "2026-10-01T10:00:00Z", endedAt: "2026-10-01T11:00:00Z", projectLabel: "demo" };
const event = { externalId: "e1", sessionExternalId: "s1", occurredAt: "2026-10-01T10:05:00Z", model: "m1", inputTokens: 10, cacheReadTokens: null, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: null };
const valid = () => ({ tool: { slug: "claude-code", name: "Claude Code" }, sessions: [session], usage: [event], activity: [{ kind: "prompt", externalId: "p1", sessionExternalId: "s1" }] });
const errorOf = (body: Record<string, unknown>) => {
  const checked = batchInput(body);
  return checked.ok ? undefined : checked.error;
};

describe("remote batch input", () => {
  it("accepts a complete batch and keeps a counter the tool did not report as null", () => {
    const checked = batchInput(valid());
    assert.ok(checked.ok);
    assert.equal(checked.value.usage[0]!.cacheReadTokens, null);
    assert.equal(checked.value.usage[0]!.cacheWriteTokens, 0);
    assert.equal(checked.value.activity[0]!.durationMs, 0);
  });

  it("accepts a batch with only a tool", () => {
    assert.ok(batchInput({ tool: { slug: "codex", name: "Codex" } }).ok);
  });

  it("names the first field it cannot use", () => {
    assert.match(errorOf({})!, /tool is required/);
    assert.match(errorOf({ ...valid(), tool: { slug: "Bad Slug", name: "x" } })!, /tool\.slug/);
    assert.match(errorOf({ ...valid(), sessions: [{ ...session, startedAt: "yesterday" }] })!, /sessions\[0\]\.startedAt/);
    assert.match(errorOf({ ...valid(), usage: [{ ...event, inputTokens: -1 }] })!, /usage\[0\]\.inputTokens/);
    assert.match(errorOf({ ...valid(), usage: [{ ...event, outputTokens: 1.5 }] })!, /usage\[0\]\.outputTokens/);
    assert.match(errorOf({ ...valid(), activity: [{ kind: "typing", externalId: "x" }] })!, /activity\[0\]\.kind/);
  });

  it("refuses an event whose session is not in the request, a NUL character and too many entries", () => {
    assert.match(errorOf({ ...valid(), usage: [{ ...event, sessionExternalId: "other" }] })!, /usage\[0\]\.sessionExternalId/);
    assert.match(errorOf({ ...valid(), sessions: [{ ...session, projectLabel: "a\u0000b" }] })!, /projectLabel/);
    assert.match(errorOf({ ...valid(), usage: new Array(2001).fill(event) })!, /at most 2000/);
  });
});
