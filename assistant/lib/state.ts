import { getDb, type DbQueryable } from "@modunexo/sdk";

export type PauseReason = "human" | "handoff" | "limit" | "manual";
export type Paused = { conversationId: number; reason: PauseReason; since: Date };

/** Stops the assistant in a conversation. Stopping a stopped conversation keeps the first reason. */
export async function pauseConversation(conversationId: number, reason: PauseReason, db: DbQueryable = getDb("assistant")): Promise<void> {
  await db.query("insert into paused (conversation_id, reason) values ($1, $2) on conflict (conversation_id) do nothing", [conversationId, reason]);
}

/**
 * Lets the assistant answer again; false when it was not stopped. A conversation that was stopped starts again from
 * `afterMessageId` (its newest message at that moment) and from `now`: a person who wrote before, or the replies of the last
 * hour, do not stop it a second time.
 */
export async function resumeConversation(conversationId: number, afterMessageId: number, now: Date = new Date()): Promise<boolean> {
  return getDb("assistant").transaction(async (tx) => {
    const removed = await tx.query("delete from paused where conversation_id = $1", [conversationId]);
    if ((removed.rowCount ?? 0) === 0) return false;
    await tx.query(
      "insert into resumed (conversation_id, after_message_id, at) values ($1, $2, $3) on conflict (conversation_id) do update set after_message_id = excluded.after_message_id, at = excluded.at",
      [conversationId, afterMessageId, now],
    );
    return true;
  });
}

export type Baseline = { afterMessageId: number; at: Date };

/** Where a resumed conversation starts again; null when it was never stopped and resumed. */
export async function resumedBaseline(conversationId: number, db: DbQueryable = getDb("assistant")): Promise<Baseline | null> {
  const found = await db.query<{ after_message_id: string; at: Date }>("select after_message_id, at from resumed where conversation_id = $1", [conversationId]);
  return found.rows[0] === undefined ? null : { afterMessageId: Number(found.rows[0].after_message_id), at: found.rows[0].at };
}

export async function pausedReason(conversationId: number, db: DbQueryable = getDb("assistant")): Promise<PauseReason | null> {
  const found = await db.query<{ reason: PauseReason }>("select reason from paused where conversation_id = $1", [conversationId]);
  return found.rows[0]?.reason ?? null;
}

export async function listPaused(): Promise<Paused[]> {
  const found = await getDb("assistant").query<{ conversation_id: string; reason: PauseReason; since: Date }>("select conversation_id, reason, since from paused order by since desc, conversation_id desc");
  return found.rows.map((row) => ({ conversationId: Number(row.conversation_id), reason: row.reason, since: row.since }));
}
