import { listConversations } from "../lib/read.ts";
import { conversationJson, refuse } from "../lib/service.ts";

/** Service API: the newest conversations, optionally only those with unread messages. Needs the scope `messages.read`. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= 1 && limit <= 100)) return refuse('"limit" must be a whole number from 1 to 100.', 400);
  }
  const unread = params.get("unread");
  if (unread !== null && unread !== "true" && unread !== "false") return refuse('"unread" must be true or false.', 400);
  const rows = await listConversations(limit, { unreadOnly: unread === "true" });
  return Response.json({ conversations: rows.map(conversationJson) });
}
