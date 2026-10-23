import { refuse } from "../lib/form.ts";
import { createLead, leadInput } from "../lib/pipeline.ts";
import { readJson } from "../lib/service.ts";

/** Service API: creates a lead for a contact, in the first stage. Needs the scope `leads.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const checked = leadInput(body);
  if (!checked.ok) return refuse(checked.error, 400);
  const made = await createLead(checked.value);
  return made.ok ? Response.json({ id: made.id }, { status: 201 }) : refuse("contact_not_found", 404);
}
