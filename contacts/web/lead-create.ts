import { fieldsOf, readForm, redirect, refuse } from "../lib/form.ts";
import { createLead, leadInput } from "../lib/pipeline.ts";

/** The new-lead form. The lead starts in the first stage. The gate has already required `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const checked = leadInput(fieldsOf(form));
  if (!checked.ok) return refuse(checked.error, 400);
  const made = await createLead(checked.value);
  return made.ok ? redirect("/pipeline") : refuse("No such contact.", 404);
}
