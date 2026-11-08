import { getContact } from "../lib/contacts.ts";
import { idOf, refuse } from "../lib/form.ts";
import { leadsOfContact } from "../lib/pipeline.ts";

/** Service API: the leads of the contact `contactId`, with the name of the stage each is in. Needs the scope `leads.read`. */
export async function GET(request: Request): Promise<Response> {
  const contactId = idOf(new URL(request.url).searchParams.get("contactId"));
  if (contactId === null) return refuse('"contactId" must be a number.', 400);
  if ((await getContact(contactId)) === null) return refuse("not_found", 404);
  const leads = await leadsOfContact(contactId);
  return Response.json({ leads: leads.map((lead) => ({ id: lead.id, title: lead.title, amount: lead.amount, priority: lead.priority, stage: lead.stage, closedAt: lead.closedAt === null ? null : lead.closedAt.toISOString() })) });
}
