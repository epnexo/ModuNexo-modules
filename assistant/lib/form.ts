/** Same rule as the shell's own forms: the request must come from a page served by this host. Forwarding headers are not consulted. */
export function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const refuse = (message: string, status: number): Response => Response.json({ error: message }, { status });
export const redirect = (to: string): Response => new Response(null, { status: 303, headers: { location: to } });

/** The form of a request from this site, or the response that refuses it. */
export async function readForm(request: Request): Promise<FormData | Response> {
  if (!sameOrigin(request.headers)) return refuse("The request must come from this site.", 403);
  try {
    return await request.formData();
  } catch {
    return refuse("The body must be a form.", 400);
  }
}

/** The text fields of a form as an object; a file or a missing field is left out. */
export function fieldsOf(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") fields[key] = value;
  return fields;
}

/** A row id from a form field, or null when it is not a whole number above zero. */
export const idOf = (raw: string | undefined): number | null => (raw !== undefined && /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);
