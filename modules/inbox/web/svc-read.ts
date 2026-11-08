import { loadConversation, markRead } from "../lib/read.ts";
import { idOf, readJson, refuse } from "../lib/service.ts";

/** Service API: clears the unread count of a conversation. Needs the scope `messages.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const conversationId = idOf(body.conversationId);
  if (conversationId === null) return refuse('"conversationId" must be a number.', 400);
  if ((await loadConversation(conversationId)) === null) return refuse("not_found", 404);
  await markRead(conversationId);
  return Response.json({ ok: true });
}
