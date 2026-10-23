import type { ConversationRow, MessageRow } from "./read.ts";

const MAX_BODY_CHARS = 16_384;

export const refuse = (message: string, status: number): Response => Response.json({ error: message }, { status });

/** A row id from a query parameter or a JSON value, or null when it is not a whole number above zero. */
export function idOf(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  return /^\d{1,15}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/** The JSON object a service caller posted, or the response that refuses it (413 over 16 KiB, 400 when it is not an object). */
export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) return refuse("The body is too large.", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return refuse("The body is too large.", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse("The body must be JSON.", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse("The body must be a JSON object.", 400);
  return parsed as Record<string, unknown>;
}

export const conversationJson = (c: ConversationRow) => ({
  id: c.id,
  channel: c.channel,
  contactRef: c.contactRef,
  contactName: c.contactName,
  contactId: c.contactId,
  unread: c.unread,
  lastMessageAt: c.lastMessageAt.toISOString(),
  lastText: c.lastText,
});

export const messageJson = (m: MessageRow) => ({ id: m.id, direction: m.direction, text: m.text, status: m.status, error: m.error, createdAt: m.createdAt.toISOString() });
