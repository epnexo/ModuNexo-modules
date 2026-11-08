import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexCollector } from "../../modules/ai-usage/src/collectors/codex.ts";
import { send, toParts } from "../../modules/ai-usage/src/remote-sender.ts";
import { batchInput } from "../../modules/ai-usage/lib/remote.ts";

const fixtures = fileURLToPath(new URL("./fixtures/codex", import.meta.url));
let work: string;
before(() => {
  work = mkdtempSync(join(tmpdir(), "ai-usage-sender-"));
  cpSync(fixtures, join(work, "codex"), { recursive: true });
});
after(() => rmSync(work, { recursive: true, force: true }));

type Call = { url: string; auth: string | null; body: Record<string, unknown> };
const fakePlatform = (status = 200) => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, auth: new Headers(init.headers).get("authorization"), body });
    // The real endpoint's own validation decides whether a request is acceptable.
    const checked = batchInput(body);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    return Response.json({ sessionsInserted: checked.value.sessions.length, eventsInserted: checked.value.usage.length, tokensInserted: 1 }, { status });
  }) as typeof fetch;
  return { calls, fetcher };
};
const collector = () => createCodexCollector({ root: join(work, "codex") });

describe("remote sender", () => {
  it("posts what the collector found with the token, in requests the endpoint accepts", async () => {
    const state = join(work, "state-1.json");
    const { calls, fetcher } = fakePlatform();
    const [report] = await send([collector()], { url: "https://platform.test/base", token: "secret", stateFile: state, fetch: fetcher });
    assert.equal(report!.filesFailed, 0);
    assert.ok(calls.length >= 1 && report!.eventsInserted >= 1);
    assert.ok(calls.every((c) => c.url === "https://platform.test/svc/ai-usage/ingest" && c.auth === "Bearer secret"));
    assert.ok(existsSync(state));
  });

  it("sends nothing for files that did not change since the last run", async () => {
    const state = join(work, "state-2.json");
    await send([collector()], { url: "https://platform.test", token: "t", stateFile: state, fetch: fakePlatform().fetcher });
    const second = fakePlatform();
    const [report] = await send([collector()], { url: "https://platform.test", token: "t", stateFile: state, fetch: second.fetcher });
    assert.equal(second.calls.length, 0);
    assert.equal(report!.filesSkipped, report!.filesScanned);
  });

  it("reports a refused request by code only and sends the file again next run", async () => {
    const state = join(work, "state-3.json");
    const refusing = (async () => Response.json({ error: "secret detail" }, { status: 403 })) as unknown as typeof fetch;
    const [failed] = await send([collector()], { url: "https://platform.test", token: "bad", stateFile: state, fetch: refusing });
    assert.ok(failed!.filesFailed >= 1);
    assert.ok(failed!.failedFiles.every((f) => f.reason === "HTTP_403" && !f.id.includes("rollout")));
    const retry = fakePlatform();
    const [again] = await send([collector()], { url: "https://platform.test", token: "good", stateFile: state, fetch: retry.fetcher });
    assert.equal(again!.filesFailed, 0);
    assert.ok(retry.calls.length >= 1);
  });

  it("starts over when the state file is unreadable", async () => {
    const state = join(work, "state-4.json");
    writeFileSync(state, "{not json");
    const { calls, fetcher } = fakePlatform();
    await send([collector()], { url: "https://platform.test", token: "t", stateFile: state, fetch: fetcher });
    assert.ok(calls.length >= 1);
  });
});

describe("toParts", () => {
  const session = (id: string) => ({ externalId: id, startedAt: new Date(0), endedAt: new Date(1), projectLabel: null });
  const event = (id: string, s: string) => ({ externalId: id, sessionExternalId: s, occurredAt: new Date(0), model: null, inputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 1, reasoningTokens: null });

  it("splits at 2000 entries and repeats the sessions each part refers to", () => {
    const usage = Array.from({ length: 4500 }, (_, i) => event(`e${i}`, i % 2 === 0 ? "a" : "b"));
    const parts = toParts([session("a"), session("b")], usage, []);
    assert.deepEqual(parts.map((p) => p.usage.length), [2000, 2000, 500]);
    assert.ok(parts.every((p) => p.sessions.length === 2));
  });

  it("still sends a session no entry refers to", () => {
    const parts = toParts([session("a"), session("lonely")], [event("e1", "a")], []);
    assert.equal(parts.length, 2);
    assert.deepEqual(parts[1]!.sessions.map((s) => s.externalId), ["lonely"]);
  });
});
