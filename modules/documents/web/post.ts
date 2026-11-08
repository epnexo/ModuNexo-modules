import type { FormInput } from "./form-state.ts";
import { logFailure } from "./log.ts";

/** A form is a few short fields; anything bigger than this is not one. */
export const MAX_BODY_BYTES = 1_000_000;

export type Outcome<S> = { state: S } | { redirectTo: string };

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

/**
 * The text fields of a request from this site, or the response that refuses it. The gate has already checked the
 * permission of the route; this checks that the browser sent it from our own page and that the body is small.
 */
export async function readFields(request: Request): Promise<FormInput | Response> {
  if (!sameOrigin(request.headers)) return refuse("The request must come from this site.", 403);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return refuse("The form is too large.", 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse("The body must be a form.", 400);
  }
  const fields: FormInput = {};
  form.forEach((value, key) => {
    if (typeof value === "string") fields[key] = value;
  });
  return fields;
}

/** The answer the page's script reads: the state to show again, or where to go next. */
export function answer<S>(outcome: Outcome<S>, extra: { reload?: boolean } = {}): Response {
  if ("redirectTo" in outcome) return Response.json({ redirectTo: outcome.redirectTo });
  return Response.json({ state: outcome.state, ...(extra.reload === true ? { reload: true } : {}) });
}

/** Runs one form handler: checks the request, runs it, and turns an unexpected failure into a safe 500. */
export async function handleForm<S>(request: Request, run: (fields: FormInput) => Promise<Response>): Promise<Response> {
  const fields = await readFields(request);
  if (fields instanceof Response) return fields;
  try {
    return await run(fields);
  } catch (error) {
    logFailure("a form request failed", error);
    return refuse("The request could not be completed. Check the platform logs.", 500);
  }
}
