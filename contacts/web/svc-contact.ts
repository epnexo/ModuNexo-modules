import { contactByIdentity, getContact } from "../lib/contacts.ts";
import { idOf, refuse } from "../lib/form.ts";
import { contactJson } from "../lib/service.ts";

/** Service API: one contact, found by `id` or by `identity` (exactly one of them). Needs the scope `contacts.read`. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawId = params.get("id");
  const identity = params.get("identity")?.trim() ?? null;
  if ((rawId === null) === (identity === null)) return refuse('Give exactly one of "id" and "identity".', 400);
  let found = null;
  if (rawId !== null) {
    const id = idOf(rawId);
    if (id === null) return refuse('"id" must be a number.', 400);
    found = await getContact(id);
  } else {
    if (identity === null || identity === "") return refuse('"identity" must not be empty.', 400);
    found = await contactByIdentity(identity);
  }
  return found === null ? refuse("not_found", 404) : Response.json(contactJson(found));
}
