import { contactByIdentity, contactInput, createContact, getContact } from "../lib/contacts.ts";
import { refuse } from "../lib/form.ts";
import { contactJson, readJson } from "../lib/service.ts";

/** Service API: creates a contact. Needs the scope `contacts.write`. An identity another contact holds answers 409 with that contact's id. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const checked = contactInput(body);
  if (!checked.ok) return refuse(checked.error, 400);
  const made = await createContact(checked.value);
  if (!made.ok) {
    const holder = checked.value.identity === null ? null : await contactByIdentity(checked.value.identity);
    return Response.json({ error: "identity_taken", id: holder?.id ?? null }, { status: 409 });
  }
  return Response.json(contactJson((await getContact(made.id))!), { status: 201 });
}
