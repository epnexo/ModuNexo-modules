import { loadConversation, loadThread, messagesAfter } from "../lib/read.ts";
import { conversationJson, idOf, messageJson, refuse } from "../lib/service.ts";

/**
 * Service API: a conversation with its messages, oldest first: the newest `limit` (1 to 200, default 100), or with `afterId`
 * those that came after that message. Reading does not mark anything as read. Needs the scope `messages.read`.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const id = idOf(params.get("conversationId"));
  if (id === null) return refuse('"conversationId" must be a number.', 400);
  const rawLimit = params.get("limit");
  let limit = 100;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= 1 && limit <= 200)) return refuse('"limit" must be a whole number from 1 to 200.', 400);
  }
  const rawAfter = params.get("afterId");
  if (rawAfter !== null && !/^\d{1,15}$/.test(rawAfter)) return refuse('"afterId" must be a whole number.', 400);
  if (rawAfter === null) {
    const thread = await loadThread(id, limit);
    return thread === null ? refuse("not_found", 404) : Response.json({ conversation: conversationJson(thread.conversation), messages: thread.messages.map(messageJson) });
  }
  const conversation = await loadConversation(id);
  if (conversation === null) return refuse("not_found", 404);
  return Response.json({ conversation: conversationJson(conversation), messages: (await messagesAfter(id, Number(rawAfter), limit)).map(messageJson) });
}
