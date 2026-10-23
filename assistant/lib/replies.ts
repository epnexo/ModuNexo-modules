import { getDb } from "@modunexo/sdk";

export type ReplyRow = { id: number; conversationId: number; messageId: number | null; status: "sending" | "sent" | "failed"; model: string | null; error: string | null; createdAt: Date };

/** The replies the assistant decided to write, newest first. */
export async function latestReplies(limit: number): Promise<ReplyRow[]> {
  const found = await getDb("assistant").query<{ id: string; conversation_id: string; message_id: string | null; status: ReplyRow["status"]; model: string | null; error: string | null; created_at: Date }>(
    "select id, conversation_id, message_id, status, model, error, created_at from replies order by id desc limit $1",
    [limit],
  );
  return found.rows.map((r) => ({ id: Number(r.id), conversationId: Number(r.conversation_id), messageId: r.message_id === null ? null : Number(r.message_id), status: r.status, model: r.model, error: r.error, createdAt: r.created_at }));
}
