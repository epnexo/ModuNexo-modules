import { idOf, refuse } from "../lib/form.ts";
import { moveLead } from "../lib/pipeline.ts";
import { readJson } from "../lib/service.ts";

/** Service API: moves a lead to a stage. Needs the scope `leads.write`. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const leadId = idOf(body.leadId);
  if (leadId === null) return refuse('"leadId" must be a number.', 400);
  const stageId = idOf(body.stageId);
  if (stageId === null) return refuse('"stageId" must be a number.', 400);
  const moved = await moveLead(leadId, stageId);
  return moved.ok ? Response.json({ ok: true, changed: moved.changed }) : refuse(moved.error, 404);
}
