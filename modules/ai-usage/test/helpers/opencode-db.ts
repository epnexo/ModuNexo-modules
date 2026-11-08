import { DatabaseSync } from "node:sqlite";

/**
 * Builds a small synthetic OpenCode database with the tables and columns the collector reads. The structure
 * mirrors a real `opencode.db`; every text value is a placeholder starting with SECRET_ so a test can prove
 * none of it reaches a parsed record. Times are epoch milliseconds.
 */
export function createOpenCodeDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    create table session (id text primary key, parent_id text, directory text not null, title text not null, time_created integer not null, time_updated integer not null);
    create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
    create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);
  `);
  const T = Date.parse("2026-10-03T08:00:00.000Z");
  const session = db.prepare("insert into session values (?, ?, ?, ?, ?, ?)");
  session.run("ses_root", null, "/work/demo-oc", "SECRET_TITLE", T, T + 600_000);
  session.run("ses_child", "ses_root", "/work/demo-oc", "SECRET_CHILD_TITLE", T + 30_000, T + 90_000);

  const message = db.prepare("insert into message values (?, ?, ?, ?, ?)");
  const user = (id: string, sessionId: string, at: number) =>
    message.run(id, sessionId, at, at, JSON.stringify({ role: "user", time: { created: at }, agent: "build", model: { providerID: "provider-a", modelID: "model-a" }, summary: { title: "SECRET_SUMMARY", diffs: [] } }));
  const assistant = (id: string, sessionId: string, at: number, modelID: string, tokens: unknown) =>
    message.run(
      id,
      sessionId,
      at,
      at + 5_000,
      JSON.stringify({ role: "assistant", parentID: "x", mode: "build", agent: "build", path: { cwd: "/work/demo-oc", root: "/" }, cost: 0, modelID, providerID: "provider-a", time: { created: at, completed: at + 4_000 }, finish: "stop", ...(tokens === undefined ? {} : { tokens }) }),
    );

  user("msg_u1", "ses_root", T + 1_000);
  assistant("msg_a1", "ses_root", T + 2_000, "model-a", { total: 1200, input: 100, output: 50, reasoning: 30, cache: { write: 20, read: 1000 } });
  assistant("msg_a2", "ses_root", T + 60_000, "vendor/model-b", { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } });
  assistant("msg_a3", "ses_root", T + 120_000, "model-b", { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assistant("msg_a4", "ses_root", T + 180_000, "model-c", undefined);
  user("msg_u2", "ses_child", T + 31_000);
  assistant("msg_a5", "ses_child", T + 32_000, "model-a", { total: 15, input: 4, output: 2, reasoning: 1, cache: { read: 8, write: 0 } });

  const part = db.prepare("insert into part values (?, ?, ?, ?, ?, ?)");
  const tool = (id: string, messageId: string, sessionId: string, at: number) =>
    part.run(id, messageId, sessionId, at, at + 1_000, JSON.stringify({ type: "tool", tool: "bash", callID: `call_${id}`, state: { status: "completed", input: { command: "SECRET_TOOL_INPUT" }, output: "SECRET_TOOL_OUTPUT", title: "SECRET_TOOL_TITLE", time: { start: at, end: at + 1_000 } } }));
  tool("prt_t1", "msg_a1", "ses_root", T + 3_000);
  tool("prt_t2", "msg_a5", "ses_child", T + 33_000);
  part.run("prt_x1", "msg_a2", "ses_root", T + 61_000, T + 61_000, JSON.stringify({ type: "text", text: "SECRET_TEXT" }));
  part.run("prt_r1", "msg_a2", "ses_root", T + 61_500, T + 61_500, JSON.stringify({ type: "reasoning", text: "SECRET_REASONING" }));
  return db;
}

export const OPENCODE_T0 = Date.parse("2026-10-03T08:00:00.000Z");
