import { MAX_BODY_CHARS, batchInput, storeBatch } from "../lib/remote.ts";

const refuse = (message: string, status: number): Response => Response.json({ error: message }, { status });

/**
 * Service API: stores the usage a collector found on a user's machine. Needs the scope `ai_usage.write`.
 * The body is `{ tool: { slug, name }, sessions, usage, activity }`; see `lib/remote.ts` for the fields. It is
 * idempotent, so a collector can resend a batch it is not sure arrived. Answers the counts it added.
 */
export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_CHARS) return refuse("The body is too large.", 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return refuse("The body is too large.", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse("The body must be JSON.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse("The body must be a JSON object.", 400);
  const checked = batchInput(body as Record<string, unknown>);
  if (!checked.ok) return refuse(checked.error, 400);
  return Response.json(await storeBatch(checked.value), { status: 200 });
}
