import { messageStatus } from "../lib/read.ts";
import { queueReply, replyText } from "../lib/reply.ts";
import { idOf, readJson, refuse } from "../lib/service.ts";

/** Service API: sends a reply the way the reply form does (stored as queued, delivery queued when an outbound URL is set). Needs the scope `messages.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const conversationId = idOf(body.conversationId);
  if (conversationId === null) return refuse('"conversationId" must be a number.', 400);
  const text = replyText(body.text);
  if (text === null) return refuse('"text" must be 1 to 4000 characters that are not blank.', 400);
  const replied = await queueReply(conversationId, text);
  if (!replied.found) return refuse("not_found", 404);
  return Response.json({ id: replied.messageId, status: (await messageStatus(replied.messageId)) ?? "queued" }, { status: 201 });
}
