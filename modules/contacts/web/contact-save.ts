import { contactInput, createContact, updateContact } from "../lib/contacts.ts";
import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";

/** The contact form: creates a contact, or changes the one named by `id`. The gate has already required `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const fields = fieldsOf(form);
  const checked = contactInput(fields);
  if (!checked.ok) return refuse(checked.error, 400);
  if (fields.id === undefined || fields.id.trim() === "") {
    const made = await createContact(checked.value);
    return made.ok ? redirect(`/contacts?c=${made.id}`) : refuse('"identity" belongs to another contact.', 409);
  }
  const id = idOf(fields.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const updated = await updateContact(id, checked.value);
  if (updated.ok) return redirect(`/contacts?c=${id}`);
  return updated.error === "not_found" ? refuse("No such contact.", 404) : refuse('"identity" belongs to another contact.', 409);
}
