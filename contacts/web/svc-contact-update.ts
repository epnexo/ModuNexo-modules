import { contactByIdentity, contactInput, getContact, updateContact } from "../lib/contacts.ts";
import { idOf, refuse } from "../lib/form.ts";
import { contactJson, readJson } from "../lib/service.ts";

const FIELDS = ["name", "phone", "email", "identity", "notes"] as const;

/** Service API: changes the fields given for the contact `id`; a field that is absent keeps its value and a null or empty optional one clears it. Needs the scope `contacts.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const id = idOf(body.id);
  if (id === null) return refuse('"id" must be a number.', 400);
  const current = await getContact(id);
  if (current === null) return refuse("not_found", 404);
  const merged: Record<string, unknown> = {};
  for (const field of FIELDS) merged[field] = field in body ? body[field] : current[field];
  const checked = contactInput(merged);
  if (!checked.ok) return refuse(checked.error, 400);
  const done = await updateContact(id, checked.value);
  if (!done.ok) {
    if (done.error === "not_found") return refuse("not_found", 404);
    const holder = checked.value.identity === null ? null : await contactByIdentity(checked.value.identity);
    return Response.json({ error: "identity_taken", id: holder?.id ?? null }, { status: 409 });
  }
  return Response.json(contactJson((await getContact(id))!));
}
