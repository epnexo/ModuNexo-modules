import { getDb, getSetting } from "@modunexo/sdk";

export type InboundRef = { id: number; createdAt: Date };
export type HistoryMessage = { id: number; direction: "in" | "out"; text: string };

/** The inbox's data, through the platform's read-only channel (this module depends on the inbox). It writes nothing there. */
const inbox = () => getDb("assistant").reader("inbox");

/** The newest message a customer sent in the conversation, or null when there is none. */
export async function latestInbound(conversationId: number): Promise<InboundRef | null> {
  const found = await inbox().query<{ id: string; created_at: Date }>("select id, created_at from messages where conversation_id = $1 and direction = 'in' order by id desc limit 1", [conversationId]);
  return found.rows[0] === undefined ? null : { id: Number(found.rows[0].id), createdAt: found.rows[0].created_at };
}

/** The last `limit` messages that were not lost in delivery, oldest first. */
export async function recentMessages(conversationId: number, limit: number): Promise<HistoryMessage[]> {
  const found = await inbox().query<{ id: string; direction: "in" | "out"; text: string }>("select id, direction, text from messages where conversation_id = $1 and status <> 'failed' order by id desc limit $2", [conversationId, limit]);
  return found.rows.map((row) => ({ id: Number(row.id), direction: row.direction, text: row.text })).reverse();
}

/** The ids of the messages sent in the conversation (the newest 200), including those whose delivery failed: someone did try to write. */
export async function sentIds(conversationId: number): Promise<number[]> {
  const found = await inbox().query<{ id: string }>("select id from messages where conversation_id = $1 and direction = 'out' order by id desc limit 200", [conversationId]);
  return found.rows.map((row) => Number(row.id));
}

export type InboxTarget = { base: string; token: string };

/** Where replies go and the token to send them with. Throws, with a phrase that holds neither, when they are missing or unusable. */
export async function inboxTarget(): Promise<InboxTarget> {
  const [url, token] = await Promise.all([getSetting("assistant", "inbox_url"), getSetting("assistant", "inbox_token")]);
  const base = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
  const secret = typeof token === "string" ? token.trim() : "";
  if (base === "") throw new Error("The inbox address is not set.");
  if (secret === "") throw new Error("The inbox token is not set.");
  let protocol: string;
  try {
    protocol = new URL(base).protocol;
  } catch {
    throw new Error("The inbox address is not a valid URL.");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("The inbox address must start with http:// or https://.");
  return { base, token: secret };
}

/**
 * Sends a reply through the inbox's service API, which stores it exactly as the reply form does. Returns the id of the
 * stored message (null if the inbox said 201 without one), or "refused" when the inbox says the conversation or the text
 * is not valid, which a retry would not fix. Anything else throws, with the status or a fixed phrase and nothing private.
 */
export async function sendReply(target: InboxTarget, conversationId: number, text: string, signal?: AbortSignal): Promise<number | null | "refused"> {
  let response: Response;
  try {
    response = await fetch(`${target.base}/svc/inbox/messages/send`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId, text }),
    });
  } catch {
    throw new Error("The inbox could not be reached.");
  }
  if (response.status === 201) {
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === "number" && Number.isSafeInteger(body.id) ? body.id : null;
  }
  if (response.status === 400 || response.status === 404) return "refused";
  throw new Error(`The inbox answered HTTP ${response.status}.`);
}

export type ConversationLine = { id: number; contactRef: string; contactName: string | null; lastMessageAt: Date };

export async function conversationExists(conversationId: number): Promise<boolean> {
  return (await inbox().query("select 1 from conversations where id = $1", [conversationId])).rows.length > 0;
}

/** The conversations with the most recent activity. */
export async function recentConversations(limit: number): Promise<ConversationLine[]> {
  const found = await inbox().query<{ id: string; contact_ref: string; contact_name: string | null; last_message_at: Date }>(
    "select id, contact_ref, contact_name, last_message_at from conversations order by last_message_at desc, id desc limit $1",
    [limit],
  );
  return found.rows.map((row) => ({ id: Number(row.id), contactRef: row.contact_ref, contactName: row.contact_name, lastMessageAt: row.last_message_at }));
}

/** The text of each of these messages, by id. */
export async function messageTexts(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const found = await inbox().query<{ id: string; text: string }>("select id, text from messages where id = any($1::bigint[])", [ids]);
  return new Map(found.rows.map((row) => [Number(row.id), row.text]));
}

/** The id of the newest message of the conversation, in either direction; 0 when there is none. */
export async function latestMessageId(conversationId: number): Promise<number> {
  const found = await inbox().query<{ id: string }>("select coalesce(max(id), 0) as id from messages where conversation_id = $1", [conversationId]);
  return Number(found.rows[0]!.id);
}
