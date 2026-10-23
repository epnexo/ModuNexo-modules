import type { ContactRow } from "./contacts.ts";
import { refuse } from "./form.ts";

const MAX_BODY_CHARS = 16_384;

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

export const contactJson = (row: ContactRow) => ({ id: row.id, name: row.name, phone: row.phone, email: row.email, identity: row.identity, notes: row.notes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
