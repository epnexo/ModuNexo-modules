import { getDb, type DbQueryable } from "@modunexo/sdk";

export type PauseReason = "human" | "handoff" | "limit" | "manual";
export type Paused = { conversationId: number; reason: PauseReason; since: Date };

/** Stops the assistant in a conversation. Stopping a stopped conversation keeps the first reason. */
export async function pauseConversation(conversationId: number, reason: PauseReason, db: DbQueryable = getDb("assistant")): Promise<void> {
  await db.query("insert into paused (conversation_id, reason) values ($1, $2) on conflict (conversation_id) do nothing", [conversationId, reason]);
}

/** Lets the assistant answer again; false when it was not stopped. */
export async function resumeConversation(conversationId: number): Promise<boolean> {
  const done = await getDb("assistant").query("delete from paused where conversation_id = $1", [conversationId]);
  return (done.rowCount ?? 0) > 0;
}

export async function pausedReason(conversationId: number, db: DbQueryable = getDb("assistant")): Promise<PauseReason | null> {
  const found = await db.query<{ reason: PauseReason }>("select reason from paused where conversation_id = $1", [conversationId]);
  return found.rows[0]?.reason ?? null;
}

export async function listPaused(): Promise<Paused[]> {
  const found = await getDb("assistant").query<{ conversation_id: string; reason: PauseReason; since: Date }>("select conversation_id, reason, since from paused order by since desc, conversation_id desc");
  return found.rows.map((row) => ({ conversationId: Number(row.conversation_id), reason: row.reason, since: row.since }));
}
