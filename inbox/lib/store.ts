import { getDb, publishEvent } from "@modunexo/sdk";
import { requestLink } from "./link.ts";
import type { Inbound } from "./payload.ts";

export interface Received {
  duplicate: boolean;
}

/**
 * Stores one inbound message. The conversation is created when it is new, the unread count grows,
 * and the event is published in the same transaction, so a write that rolls back announces nothing. A message the
 * channel already delivered (same channel and message id) changes nothing and announces nothing.
 */
export async function receiveMessage(input: Inbound): Promise<Received> {
  const done = await getDb("inbox").transaction(async (tx) => {
    // The name is a snapshot: the first message that carries one sets it, a later one never replaces it, and a new thread
    // of a person this channel already knows by name starts with that name.
    const conversation = await tx.query<{ id: string; contact_id: string | null }>(
      `insert into conversations (channel, thread_ref, contact_ref, contact_name)
       values ($1, $2, $3, coalesce($4, (select contact_name from conversations where channel = $1 and contact_ref = $3 and contact_name is not null order by id limit 1)))
       on conflict (channel, thread_ref) do update set contact_name = coalesce(conversations.contact_name, excluded.contact_name)
       returning id, contact_id`,
      [input.channel, input.threadRef, input.contact.ref, input.contact.name],
    );
    const conversationId = Number(conversation.rows[0]!.id);
    const stored = await tx.query<{ id: string }>(
      "insert into messages (conversation_id, channel, direction, text, status, provider_message_id) values ($1, $2, 'in', $3, 'received', $4) on conflict (channel, provider_message_id) where provider_message_id is not null do nothing returning id",
      [conversationId, input.channel, input.text, input.messageId],
    );
    if (stored.rows.length === 0) return { duplicate: true, conversationId, linked: true };
    await tx.query("update conversations set unread_count = unread_count + 1, last_message_at = now() where id = $1", [conversationId]);
    await publishEvent("inbox", "message.received", { channel: input.channel, conversationId, messageId: Number(stored.rows[0]!.id) }, { tx });
    return { duplicate: false, conversationId, linked: conversation.rows[0]!.contact_id !== null };
  });
  // After the commit: a link that cannot be asked for does not undo a message that is stored.
  if (!done.linked) await requestLink(done.conversationId);
  return { duplicate: done.duplicate };
}
