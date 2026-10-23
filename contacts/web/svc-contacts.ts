import { listContacts } from "../lib/contacts.ts";
import { refuse } from "../lib/form.ts";
import { contactJson } from "../lib/service.ts";

/** Service API: the newest contacts, optionally filtered by `q`, cut at `limit` (1 to 100, default 50). Needs the scope `contacts.read`. */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!(limit >= 1 && limit <= 100)) return refuse('"limit" must be a whole number from 1 to 100.', 400);
  }
  const rows = await listContacts(params.get("q") ?? "", limit);
  return Response.json({ contacts: rows.map(contactJson) });
}
