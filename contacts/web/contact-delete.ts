import { deleteContact } from "../lib/contacts.ts";
import { fieldsOf, idOf, readForm, redirect, refuse } from "../lib/form.ts";

/** Deletes a contact with its leads. The gate has already required `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const form = await readForm(request);
  if (form instanceof Response) return form;
  const id = idOf(fieldsOf(form).id);
  if (id === null) return refuse('"id" must be a number.', 400);
  return (await deleteContact(id)) ? redirect("/contacts") : refuse("No such contact.", 404);
}
