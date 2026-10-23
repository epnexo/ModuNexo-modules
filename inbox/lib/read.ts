import { getDb } from "@modunexo/sdk";

export const LIST_LIMIT = 50;
export const THREAD_LIMIT = 200;

export interface ConversationRow {
  id: number;
  channel: string;
  contactName: string | null;
  contactRef: string;
  contactId: number | null;
  unread: number;
  lastMessageAt: Date;
  lastText: string | null;
}

export interface MessageRow {
  id: number;
  direction: "in" | "out";
  text: string;
  status: "received" | "queued" | "sent" | "failed";
  error: string | null;
  createdAt: Date;
}

type RawConversation = {
  id: string;
  channel: string;
  name: string | null;
  ref: string;
  contact_id: string | null;
  unread_count: number;
  last_message_at: Date;
  last_text: string | null;
};

const CONVERSATIONS =
  "select v.id, v.channel, v.contact_name as name, v.contact_ref as ref, v.contact_id, v.unread_count, v.last_message_at, (select m.text from messages m where m.conversation_id = v.id order by m.id desc limit 1) as last_text from conversations v";

const shape = (row: RawConversation): ConversationRow => ({ id: Number(row.id), channel: row.channel, contactName: row.name, contactRef: row.ref, contactId: row.contact_id === null ? null : Number(row.contact_id), unread: row.unread_count, lastMessageAt: row.last_message_at, lastText: row.last_text });

/** The newest conversations, most recent activity first; `unreadOnly` keeps those with messages nobody has read. */
export async function listConversations(limit = LIST_LIMIT, options: { unreadOnly?: boolean } = {}): Promise<ConversationRow[]> {
  const where = options.unreadOnly === true ? " where v.unread_count > 0" : "";
  const { rows } = await getDb("inbox").query<RawConversation>(`${CONVERSATIONS}${where} order by v.last_message_at desc, v.id desc limit $1`, [limit]);
  return rows.map(shape);
}

export async function loadConversation(id: number): Promise<ConversationRow | null> {
  const { rows } = await getDb("inbox").query<RawConversation>(`${CONVERSATIONS} where v.id = $1`, [id]);
  return rows[0] === undefined ? null : shape(rows[0]);
}

type RawMessage = { id: string; direction: "in" | "out"; text: string; status: MessageRow["status"]; error: string | null; created_at: Date };
const toMessage = (r: RawMessage): MessageRow => ({ id: Number(r.id), direction: r.direction, text: r.text, status: r.status, error: r.error, createdAt: r.created_at });

/** The messages of a conversation that come after message `afterId`, oldest first, up to `limit`. */
export async function messagesAfter(conversationId: number, afterId: number, limit = THREAD_LIMIT): Promise<MessageRow[]> {
  const { rows } = await getDb("inbox").query<RawMessage>("select id, direction, text, status, error, created_at from messages where conversation_id = $1 and id > $2 order by id limit $3", [conversationId, afterId, limit]);
  return rows.map(toMessage);
}

export async function messageStatus(id: number): Promise<MessageRow["status"] | null> {
  const { rows } = await getDb("inbox").query<{ status: MessageRow["status"] }>("select status from messages where id = $1", [id]);
  return rows[0]?.status ?? null;
}

/** One conversation with its newest messages, oldest first; null when there is no such conversation. */
export async function loadThread(id: number, limit = THREAD_LIMIT): Promise<{ conversation: ConversationRow; messages: MessageRow[] } | null> {
  const db = getDb("inbox");
  const found = await db.query<RawConversation>(`${CONVERSATIONS} where v.id = $1`, [id]);
  if (found.rows.length === 0) return null;
  const { rows } = await db.query<{ id: string; direction: "in" | "out"; text: string; status: MessageRow["status"]; error: string | null; created_at: Date }>(
    "select id, direction, text, status, error, created_at from (select * from messages where conversation_id = $1 order by id desc limit $2) newest order by id",
    [id, limit],
  );
  return { conversation: shape(found.rows[0]!), messages: rows.map((r) => ({ id: Number(r.id), direction: r.direction, text: r.text, status: r.status, error: r.error, createdAt: r.created_at })) };
}

export async function markRead(id: number): Promise<void> {
  await getDb("inbox").query("update conversations set unread_count = 0 where id = $1 and unread_count <> 0", [id]);
}
