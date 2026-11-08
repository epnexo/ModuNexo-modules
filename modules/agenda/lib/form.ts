import { zonedParts } from "./time.ts";

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

/** A row id from a form field or a JSON value, or null when it is not a whole number above zero. */
export function idOf(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  return /^\d{1,15}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/** `/agenda?d=2026-10-26`: the page for the week that holds this instant, by the date in the agenda's zone. */
export function agendaAt(instant: Date, timeZone: string): string {
  const p = zonedParts(instant.getTime(), timeZone);
  return `/agenda?d=${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const NOT_AVAILABLE = "That time is not available.";
export const NOT_BOOKED = "A cancelled booking cannot be rescheduled.";
